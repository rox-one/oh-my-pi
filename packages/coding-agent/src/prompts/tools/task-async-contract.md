No polling needed.

Settled-job inspection: `hub jobs` | `hub wait` delivers its snapshot → no duplicate `async-result`. `hub jobs` gives rows only; full task output lives at `agent://<id>`.

Job IDs: process memory ~5min after settlement; afterward use agent ID: `hub send`, `agent://<id>`, `history://<id>`.

`completed`: subagent yielded successfully; claimed artifacts unverified.
