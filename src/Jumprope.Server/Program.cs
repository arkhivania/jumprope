using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.SignalR;
using Jumprope.Server;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 32 * 1024 * 1024);
builder.Services.AddSignalR();
builder.Services.AddSingleton<SessionStore>();

var app = builder.Build();
app.Use(async (context, next) =>
{
    context.Response.Headers["Content-Security-Policy"] =
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' ws: wss:; " +
        "img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    context.Response.Headers["Referrer-Policy"] = "no-referrer";
    context.Response.Headers["X-Frame-Options"] = "DENY";
    await next();
});
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/sessions", async (SessionStore store, CancellationToken cancellationToken) =>
    Results.Ok(await store.GetSummariesAsync(cancellationToken)));

app.MapGet("/api/sessions/{sessionId}", async (
    string sessionId,
    SessionStore store,
    CancellationToken cancellationToken) =>
{
    if (!IsValidId(sessionId))
    {
        return Results.BadRequest(new ApiError("Session ID must contain 1-80 letters, digits, hyphens, or underscores."));
    }

    var session = await store.GetSessionAsync(sessionId, cancellationToken);
    return session is null ? Results.NotFound() : Results.Ok(session);
});

app.MapPut("/api/sessions/{sessionId}/view", async (
    string sessionId,
    ViewInput? input,
    SessionStore store,
    IHubContext<SessionHub> hub,
    CancellationToken cancellationToken) =>
{
    if (!IsValidId(sessionId))
    {
        return Results.BadRequest(new ApiError("Session ID must contain 1-80 letters, digits, hyphens, or underscores."));
    }

    var validationError = ValidateView(input);
    if (validationError is not null)
    {
        return Results.BadRequest(new ApiError(validationError));
    }

    var session = await store.ReplaceViewAsync(sessionId, input!, cancellationToken);
    await hub.Clients.All.SendAsync("sessionUpdated", sessionId, cancellationToken);
    return Results.Ok(session);
});

app.MapDelete("/api/sessions/{sessionId}", async (
    string sessionId,
    SessionStore store,
    IHubContext<SessionHub> hub,
    CancellationToken cancellationToken) =>
{
    if (!IsValidId(sessionId))
    {
        return Results.BadRequest(new ApiError("Invalid session ID."));
    }

    var deleted = await store.DeleteSessionAsync(sessionId, cancellationToken);
    if (deleted)
    {
        await hub.Clients.All.SendAsync("sessionDeleted", sessionId, cancellationToken);
    }

    return deleted ? Results.NoContent() : Results.NotFound();
});

app.MapPost("/api/interactions/{interactionId}/result", async (
    string interactionId,
    JsonElement result,
    SessionStore store,
    IHubContext<SessionHub> hub,
    CancellationToken cancellationToken) =>
{
    if (!IsValidId(interactionId))
    {
        return Results.BadRequest(new ApiError("Invalid interaction ID."));
    }

    if (JsonSerializer.SerializeToUtf8Bytes(result).Length > 64 * 1024)
    {
        return Results.BadRequest(new ApiError("Interaction results cannot exceed 64 KB."));
    }

    var response = await store.CompleteInteractionAsync(interactionId, result, cancellationToken);
    if (response is null)
    {
        return Results.Conflict(new ApiError("Interaction does not exist or is no longer pending."));
    }

    await hub.Clients.All.SendAsync("interactionCompleted", interactionId, cancellationToken);
    return Results.Ok(response);
});

app.MapPost("/api/interactions/{interactionId}/failure", async (
    string interactionId,
    InteractionFailure? failure,
    SessionStore store,
    IHubContext<SessionHub> hub,
    CancellationToken cancellationToken) =>
{
    if (!IsValidId(interactionId))
    {
        return Results.BadRequest(new ApiError("Invalid interaction ID."));
    }

    if (failure is null || string.IsNullOrWhiteSpace(failure.Error) || failure.Error.Length > 4096)
    {
        return Results.BadRequest(new ApiError("A failure message of 1-4096 characters is required."));
    }

    var result = JsonSerializer.SerializeToUtf8Bytes(new { error = failure.Error });
    if (result.Length > 64 * 1024)
    {
        return Results.BadRequest(new ApiError("Interaction results cannot exceed 64 KB."));
    }

    var response = await store.FailInteractionAsync(interactionId, failure.Error, cancellationToken);
    if (response is null)
    {
        return Results.Conflict(new ApiError("Interaction does not exist or is no longer pending."));
    }

    await hub.Clients.All.SendAsync("interactionCompleted", interactionId, cancellationToken);
    return Results.Ok(response);
});

app.MapGet("/api/interactions/{interactionId}/result", async (
    string interactionId,
    SessionStore store,
    CancellationToken cancellationToken) =>
{
    if (!IsValidId(interactionId))
    {
        return Results.BadRequest(new ApiError("Invalid interaction ID."));
    }

    var (found, response) = await store.WaitForInteractionAsync(interactionId, cancellationToken);
    return found ? Results.Ok(response) : Results.NotFound();
});

app.MapHub<SessionHub>("/hubs/sessions");
app.Run();

static bool IsValidId(string? value) =>
    value is not null &&
    value.Length is > 0 and <= 80 &&
    Regex.IsMatch(value, "^[A-Za-z0-9_-]+$", RegexOptions.CultureInvariant);

static string? ValidateView(ViewInput? input)
{
    if (input is null || input.Elements is null)
    {
        return "A view with an elements array is required.";
    }

    if (input.RowsCount is < 1 or > 32 || input.ColumnsCount is < 1 or > 32)
    {
        return "RowsCount and ColumnsCount must be between 1 and 32.";
    }

    if (input.Elements.Count > 128)
    {
        return "A view can contain at most 128 elements.";
    }

    var ids = new HashSet<string>(StringComparer.Ordinal);
    foreach (var element in input.Elements)
    {
        if (element is null)
        {
            return "Elements cannot be null.";
        }

        if (!IsValidId(element.Id) || !ids.Add(element.Id))
        {
            return "Element IDs must be unique and contain 1-80 letters, digits, hyphens, or underscores.";
        }

        if (element.Row < 0 || element.Column < 0 ||
            element.RowSpan < 1 || element.ColumnSpan < 1 ||
            element.RowSpan > input.RowsCount ||
            element.ColumnSpan > input.ColumnsCount ||
            element.Row > input.RowsCount - element.RowSpan ||
            element.Column > input.ColumnsCount - element.ColumnSpan)
        {
            return $"Element '{element.Id}' has a grid position or span outside the layout.";
        }

        switch (element.Type)
        {
            case "markdown":
                if (element.Text is null || element.Text.Length > 1_000_000 ||
                    element.DataBase64 is not null || element.ContentType is not null)
                {
                    return $"Markdown element '{element.Id}' requires text only (up to 1 MB).";
                }
                break;
            case "image":
                var imageError = ValidateBinaryElement(element, 8 * 1024 * 1024);
                if (imageError is not null)
                {
                    return imageError;
                }

                if (element.ContentType is not ("image/png" or "image/jpeg" or "image/gif" or "image/webp"))
                {
                    return $"Image element '{element.Id}' must use PNG, JPEG, GIF, or WebP.";
                }
                break;
            case "wasm":
                var wasmError = ValidateBinaryElement(element, 4 * 1024 * 1024);
                if (wasmError is not null)
                {
                    return wasmError;
                }

                if (element.ContentType != "application/wasm")
                {
                    return $"WASM element '{element.Id}' must use application/wasm.";
                }

                var bytes = Convert.FromBase64String(element.DataBase64!);
                if (bytes.Length < 4 || bytes[0] != 0 || bytes[1] != 0x61 || bytes[2] != 0x73 || bytes[3] != 0x6d)
                {
                    return $"WASM element '{element.Id}' does not contain a valid WebAssembly binary header.";
                }
                break;
            default:
                return $"Element '{element.Id}' has unsupported type '{element.Type}'.";
        }
    }

    return null;
}

static string? ValidateBinaryElement(ElementInput element, int maxBytes)
{
    if (element.Text is not null || element.DataBase64 is null || element.ContentType is null)
    {
        return $"Element '{element.Id}' requires base64 data and a content type.";
    }

    try
    {
        if (Convert.FromBase64String(element.DataBase64).Length > maxBytes)
        {
            return $"Element '{element.Id}' exceeds the {maxBytes / 1024 / 1024} MB size limit.";
        }
    }
    catch (FormatException)
    {
        return $"Element '{element.Id}' contains invalid base64 data.";
    }

    return null;
}

public partial class Program { }
