## Thread — Request key on the Telegram link and status requests

The two signed alert requests whose answer goes back to the sender, starting a Telegram link and reading the Telegram link status, now carry a request key. The app makes 32 random bytes for each request, signs their hash inside the message on a new "Request key" line, and sends the bytes beside the signature. The alert service refuses either request without the bytes, and a request whose bytes do not match the signed hash fails verification. The key lives only in the call that made it and is never stored.

With the key in place, a request whose signature is verified through the wallet's own contract (a multi-signature or smart-contract wallet) is accepted for a day instead of ten minutes, since such a wallet can take hours to gather its approvals. A request signed by an ordinary key keeps the ten-minute window, every request keeps the ten-minute limit on a time in the future, and the one-use record of each request lasts as long as that request could be accepted.

The link and status messages change, so the app and the alert service ship together; prelive, no older message is kept. Other apps that start these requests must send the key too.

Part of #3770.
