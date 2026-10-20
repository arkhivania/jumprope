using System.Text.Json;

namespace Jumprope.Server;

public sealed record ViewInput(
    int RowsCount,
    int ColumnsCount,
    List<ElementInput> Elements);

public sealed record ElementInput(
    string Id,
    string Type,
    int Row,
    int Column,
    int RowSpan,
    int ColumnSpan,
    string? Text = null,
    string? DataBase64 = null,
    string? ContentType = null);

public sealed class StoredSession
{
    public required string SessionId { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public int RowsCount { get; set; }
    public int ColumnsCount { get; set; }
    public List<StoredElement> Elements { get; set; } = [];
    public List<StoredInteraction> Interactions { get; set; } = [];
}

public sealed class StoredElement
{
    public required string Id { get; set; }
    public required string Type { get; set; }
    public int Row { get; set; }
    public int Column { get; set; }
    public int RowSpan { get; set; }
    public int ColumnSpan { get; set; }
    public string? Text { get; set; }
    public string? DataBase64 { get; set; }
    public string? ContentType { get; set; }
    public string? InteractionId { get; set; }
}

public sealed class StoredInteraction
{
    public required string Id { get; set; }
    public required string ElementId { get; set; }
    public required string Status { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    public JsonElement? Result { get; set; }
}

public sealed record InteractionResponse(
    string Id,
    string Status,
    JsonElement? Result,
    DateTimeOffset? CompletedAt);

public sealed record InteractionFailure(string Error);

public sealed record SessionSummary(
    string SessionId,
    DateTimeOffset UpdatedAt,
    int RowsCount,
    int ColumnsCount,
    IReadOnlyList<SessionElementSummary> Elements);

public sealed record SessionElementSummary(
    string Id,
    string Type,
    string? InteractionId,
    string? InteractionStatus);

public sealed record ApiError(string Error);
