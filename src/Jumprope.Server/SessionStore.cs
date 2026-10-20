using System.Text.Json;

namespace Jumprope.Server;

public sealed class SessionStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private readonly string _root;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Dictionary<string, StoredSession> _sessions = new(StringComparer.Ordinal);
    private readonly Dictionary<string, TaskCompletionSource<InteractionResponse>> _waiters = new(StringComparer.Ordinal);

    public SessionStore(IWebHostEnvironment environment)
    {
        _root = Path.Combine(environment.ContentRootPath, "data");
        Directory.CreateDirectory(_root);

        foreach (var file in Directory.EnumerateFiles(_root, "*.json"))
        {
            var session = JsonSerializer.Deserialize<StoredSession>(File.ReadAllText(file), JsonOptions);
            if (session is not null)
            {
                _sessions[session.SessionId] = session;
            }
        }
    }

    public async Task<IReadOnlyList<SessionSummary>> GetSummariesAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            return _sessions.Values
                .OrderBy(session => session.UpdatedAt)
                .Select(session => new SessionSummary(
                    session.SessionId,
                    session.UpdatedAt,
                    session.RowsCount,
                    session.ColumnsCount,
                    session.Elements.Select(element => new SessionElementSummary(
                        element.Id,
                        element.Type,
                        element.InteractionId,
                        element.InteractionId is null
                            ? null
                            : session.Interactions.FirstOrDefault(item => item.Id == element.InteractionId)?.Status))
                        .ToArray()))
                .ToArray();
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<StoredSession?> GetSessionAsync(string sessionId, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            return _sessions.TryGetValue(sessionId, out var session) ? Clone(session) : null;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<StoredSession> ReplaceViewAsync(
        string sessionId,
        ViewInput input,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            _sessions.TryGetValue(sessionId, out var existingSession);
            var session = existingSession is null
                ? new StoredSession { SessionId = sessionId }
                : Clone(existingSession);

            var cancelledInteractions = session.Interactions.Where(item => item.Status == "pending").ToArray();
            foreach (var interaction in cancelledInteractions)
            {
                interaction.Status = "cancelled";
                interaction.CompletedAt = DateTimeOffset.UtcNow;
            }

            var elements = input.Elements.Select(element => new StoredElement
            {
                Id = element.Id,
                Type = element.Type,
                Row = element.Row,
                Column = element.Column,
                RowSpan = element.RowSpan,
                ColumnSpan = element.ColumnSpan,
                Text = element.Text,
                DataBase64 = element.DataBase64,
                ContentType = element.ContentType,
                Interactive = element.Type == "wasm" ? element.Interactive ?? true : null,
                InteractionId = element.Type == "wasm" && (element.Interactive ?? true)
                    ? Guid.NewGuid().ToString("N")
                    : null
            }).ToList();

            var newInteractions = elements
                .Where(element => element.InteractionId is not null)
                .Select(element => new StoredInteraction
                {
                    Id = element.InteractionId!,
                    ElementId = element.Id,
                    Status = "pending",
                    CreatedAt = DateTimeOffset.UtcNow
                });

            session.RowsCount = input.RowsCount;
            session.ColumnsCount = input.ColumnsCount;
            session.Elements = elements;
            session.Interactions.AddRange(newInteractions);
            session.UpdatedAt = DateTimeOffset.UtcNow;
            await PersistAsync(session, cancellationToken);
            _sessions[sessionId] = session;
            foreach (var interaction in cancelledInteractions)
            {
                CompleteWaiter(interaction);
            }

            return Clone(session);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<bool> DeleteSessionAsync(string sessionId, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (!_sessions.TryGetValue(sessionId, out var session))
            {
                return false;
            }

            var path = SessionPath(sessionId);
            if (File.Exists(path))
            {
                File.Delete(path);
            }

            _sessions.Remove(sessionId);
            foreach (var interaction in session.Interactions.Where(item => item.Status == "pending"))
            {
                interaction.Status = "cancelled";
                interaction.CompletedAt = DateTimeOffset.UtcNow;
                CompleteWaiter(interaction);
            }

            return true;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<InteractionResponse?> CompleteInteractionAsync(
        string interactionId,
        JsonElement result,
        CancellationToken cancellationToken)
        => await FinishInteractionAsync(interactionId, "completed", result, cancellationToken);

    public async Task<InteractionResponse?> FailInteractionAsync(
        string interactionId,
        string error,
        CancellationToken cancellationToken)
        => await FinishInteractionAsync(
            interactionId,
            "failed",
            JsonSerializer.SerializeToElement(new { error }),
            cancellationToken);

    private async Task<InteractionResponse?> FinishInteractionAsync(
        string interactionId,
        string status,
        JsonElement result,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var (existingSession, existingInteraction) = FindInteraction(interactionId);
            if (existingSession is null || existingInteraction is null || existingInteraction.Status != "pending")
            {
                return null;
            }

            var session = Clone(existingSession);
            var interaction = session.Interactions.Single(item => item.Id == interactionId);
            interaction.Status = status;
            interaction.Result = result.Clone();
            interaction.CompletedAt = DateTimeOffset.UtcNow;
            session.UpdatedAt = DateTimeOffset.UtcNow;
            await PersistAsync(session, cancellationToken);
            _sessions[session.SessionId] = session;

            var response = ToResponse(interaction);
            CompleteWaiter(interaction);
            return response;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<(bool Found, InteractionResponse? Response)> WaitForInteractionAsync(
        string interactionId,
        CancellationToken cancellationToken)
    {
        Task<InteractionResponse>? pendingTask = null;

        await _gate.WaitAsync(cancellationToken);
        try
        {
            var (_, interaction) = FindInteraction(interactionId);
            if (interaction is null)
            {
                return (false, null);
            }

            if (interaction.Status != "pending")
            {
                return (true, ToResponse(interaction));
            }

            if (!_waiters.TryGetValue(interactionId, out var waiter))
            {
                waiter = new TaskCompletionSource<InteractionResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
                _waiters[interactionId] = waiter;
            }

            pendingTask = waiter.Task;
        }
        finally
        {
            _gate.Release();
        }

        var response = await pendingTask.WaitAsync(cancellationToken);
        return (true, response);
    }

    private (StoredSession? Session, StoredInteraction? Interaction) FindInteraction(string interactionId)
    {
        foreach (var session in _sessions.Values)
        {
            var interaction = session.Interactions.FirstOrDefault(item => item.Id == interactionId);
            if (interaction is not null)
            {
                return (session, interaction);
            }
        }

        return (null, null);
    }

    private void CompleteWaiter(StoredInteraction interaction)
    {
        if (_waiters.Remove(interaction.Id, out var waiter))
        {
            waiter.TrySetResult(ToResponse(interaction));
        }
    }

    private static InteractionResponse ToResponse(StoredInteraction interaction) =>
        new(interaction.Id, interaction.Status, interaction.Result, interaction.CompletedAt);

    private async Task PersistAsync(StoredSession session, CancellationToken cancellationToken)
    {
        var path = SessionPath(session.SessionId);
        var temporaryPath = $"{path}.{Guid.NewGuid():N}.tmp";
        var json = JsonSerializer.Serialize(session, JsonOptions);
        await File.WriteAllTextAsync(temporaryPath, json, cancellationToken);
        File.Move(temporaryPath, path, overwrite: true);
    }

    private string SessionPath(string sessionId) => Path.Combine(_root, $"{sessionId}.json");

    private static StoredSession Clone(StoredSession session) =>
        JsonSerializer.Deserialize<StoredSession>(JsonSerializer.Serialize(session, JsonOptions), JsonOptions)!;
}
