### Market-listing check on pasted token addresses (alpha02)

Pasting an unknown token address into an offer form now also asks the
wider market about it, alongside the existing security screen
(#1036, the final layer of the token screen):

- A listed token shows its market name, symbol, and rank — a quick
  identity check that the address really is the token you meant.
- A listed-but-small token (outside the top 200) gets a plain-words
  caution: smaller tokens move harder and disappear faster.
- An address with no market listing at all says so — not as an
  accusation, but as a prompt to verify the contract address with the
  project before dealing in it.

This is a soft signal only: it never blocks anything (the security
screen keeps that job), it stays silent when the lookup itself fails,
and it doesn't appear on test networks — where no test token has a
market listing and the line would only teach people to ignore it.
