## Indexer — the recycling and reward routes stop echoing error text

When the recycling series or the reward loop-closure query failed, the
indexer's public answer carried the raw error text alongside the failure. That
text can hold an RPC address with its key. Both answers now say only that the
query failed; the cause goes to the indexer's own log, with addresses, keys and
tokens removed by the shared formatter. The recycling backing read's warning is
redacted the same way. The shared redaction check no longer lists these two
files as pending, so it now covers them; the one file it still exempts is
waiting on #2757. Refs #2759.
