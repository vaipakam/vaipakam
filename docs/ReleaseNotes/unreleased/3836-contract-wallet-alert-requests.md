## Agent and app — alert requests from multi-signature wallets

A wallet that needs several owners to approve (a multi-signature wallet such as a Safe) could not use alerts: the signed time goes into the request before the owners are asked, and the alert service refused any request older than ten minutes. Linking or unlinking Telegram, saving alert settings and sending a test alert all failed for such wallets once their approvals took longer than that.

A request whose approval comes only from the wallet's contract on the named network is now accepted for up to seven days after it was made. A signature that recovers to the wallet's own key keeps the ten-minute window, whatever code sits at the address, and no request may be dated more than ten minutes ahead. The one-time record of each accepted request is now kept for the window that applied, so a request cannot be presented twice within it.

Every alert request now names a request key held by the requesting browser: the app draws a random secret for each request, the signed text carries its hash, and the request carries the secret. The service accepts a request only with the key its text names, so only the browser that started a request can finish it. The app keeps the pending request in this browser until the service has answered, and the Alerts card offers to finish or discard it, says that only this browser can finish it, and states the seven-day limit. The browser's data export shows a pending request but withholds its key, and says so.

With requests that can wait days, two different requests could arrive out of order. Each change is now applied only when no request signed later has already been applied to it, in the same step as the change: link and unlink requests are ordered together per wallet and network (an unlink signed with the wallet's own key, which clears every network, raises the order on every network), and settings saves are ordered on the wallet's settings row (new shared database migration `0116`, a nullable column). An older request changes nothing and the app says a newer one was already applied. The test alert changes nothing and is not ordered. An unlink, applied at once or after a protected-mode wait, still voids any unfinished link code for its wallet and network.

The four signed alert texts changed while the platform is prelive. The other connected app (alpha05) does the same: each alert request names its own key, a request not yet answered is kept in the browser with Finish and Discard on the Alerts page and the seven-day limit stated, and its data download withholds the key and says so.

Closes #3836

> Caveat: a request a multi-signature wallet is still approving can be finished only from the browser that started it, and only while that browser keeps its site data.
