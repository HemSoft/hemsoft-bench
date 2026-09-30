# Stream failure diagnostics

Retries keep work alive. They do not explain why a response stopped. New attempts record a separate, bounded transport log to distinguish provider protocol failures, fetch errors, SDK interpretation and local stops.

## Known adapter behavior

Pi 0.87.1 raises `Stream ended without finish_reason` after its OpenAI-compatible stream iterator ends without the required finish reason. That message does not distinguish normal HTTP EOF, an explicit `[DONE]`, a response-body abort, or a parsing problem.

The installed OpenAI SDK can catch a response-body `AbortError` and return from its iterator. Pi can then report a missing finish reason instead of the underlying abort. An offline test reproduces this using the installed Pi adapter, with an injected fetch and no real credentials or network calls.

OpenRouter can also end a stream with its documented `finish_reason: "error"` marker. Pi 0.87.1 does not classify the generic `Provider finish_reason: error` message as transient. Execution-policy version 4 narrowly rewrites this OpenRouter marker to Pi's retryable `network_error` finish reason after the diagnostic observer records the original stream.

## Automatic capture

Each new attempt gets `transport.jsonl` beside its `result.json`. The result records the diagnostic file path. Capture starts through the benchmark's existing extension, after Pi has installed its Undici fetch implementation. It does not patch the installed Pi package or change global settings.

For each allowed provider request, the log records:

- A request ordinal shared by the budget check, fetch observer and adapter result.
- HTTP status, time to headers, and a hash of a provider request identifier when available.
- Consumed bytes, read timing, maximum read gaps, and a hash of consumed response bytes.
- Counts of text, reasoning and tool-call delta frames, plus the last content kinds observed.
- Whether usage, `finish_reason`, `[DONE]`, or a Responses/Anthropic terminal event arrived.
- Normal EOF, fetch/read errors, consumer cancellation and fetch abort signals.
- Pi's resulting stop reason and a bounded error category.
- Request blocks caused by budget checks or stop markers.

The observer forwards the same bytes and errors to Pi. It reads only when Pi consumes the stream, without teeing the response into an eager background buffer. It neither accepts an unfinished response nor rewrites provider errors.

## Read a diagnosis

From the repository root:

```powershell
node src/diagnose-stream.mjs "PATH\TO\THE\ATTEMPT\result.json"
```

The command reads saved files only. It does not call a provider or retry the attempt.

| Condition | What the evidence supports |
|---|---|
| `eof_without_finish_reason` | The observed HTTP body ended normally without the expected chat completion marker. |
| `done_without_finish_reason` | `[DONE]` arrived, but no preceding finish reason did. |
| `stream_read_failed` | Fetch raised an error while the response body was being consumed. Inspect the bounded error code. |
| `body_abort_masked_as_missing_finish` | Fetch reported a body `AbortError`, while Pi reported a missing finish reason. This is the reproduced SDK masking path. |
| `fetch_signal_aborted` | The fetch signal was aborted. Check the run's stop reason before attributing it to user cancellation or a deadline. |
| `fetch_failed` | Fetch failed before returning response headers. |
| `http_error` | The response had an unsuccessful HTTP status. Response bodies are not copied into this log. |
| `provider_error_event` | The stream explicitly reported an error or an unsuccessful terminal event. |
| `finish_marker_adapter_disagreement` | A marker was observed, but Pi reported it missing. Investigate parsing and protocol compatibility; this alone does not prove a Pi defect. |
| `completion_marker_observed` | The expected completion marker arrived. This is not a code-correctness grade. |
| `inspection_incomplete` | Malformed, oversized, partial or capped evidence prevents a reliable protocol verdict. |
| `no_transport_end_record` | The trace stopped before a terminal observation. Process termination and lost diagnostics are both possible. |

`unobservedRequests`, missing adapter records and `captureLimited` identify gaps. Do not turn missing evidence into a provider-failure diagnosis. A normal HTTP EOF also cannot identify which upstream service or proxy ended the response.

## Privacy and limits

The transport log excludes request bodies, prompts, generated text, reasoning, tool arguments, full URLs, authentication headers, cookies and exception messages. Request identifiers are hashed. Existing private Pi event and stderr artifacts keep their previous behavior; this diagnostic log does not duplicate their content.

Capture is capped at 2 MiB per attempt. SSE inspection limits frames to 65,536 characters, with separately bounded line and decoder buffers. Oversized or malformed frames mark the diagnosis uncertain rather than being silently treated as missing completion markers. Progress snapshots are written on the first read and at most once per five seconds of subsequent reads, plus lifecycle events.

Timing describes consumption at the fetch boundary, after decompression. It is not packet-arrival timing. The observer does not capture raw TCP, TLS, WebSocket traffic, or SDK transports that bypass global fetch. The diagnostic command reports coverage gaps rather than assuming those transports were observed.

A logging failure must not change inference, trigger a retry, or reset a budget. A hard process kill can leave the last trace incomplete. The next authorized live run is needed to determine which condition occurs with the actual provider.

## Verification

The integration tests use real installed Pi with loopback SSE to distinguish ordinary EOF, `[DONE]` without a finish reason, and a socket reset. They also check request/cost limits, deadlines, cancellation, quota errors and authentication errors. A separate adapter test reproduces the swallowed `AbortError` path.

Unit tests cover byte-split UTF-8, CRLF framing, marker ordering, redaction, bounds, pull-driven consumption, unchanged exception propagation, writer failures and uncertain evidence. No paid model calls are required.
