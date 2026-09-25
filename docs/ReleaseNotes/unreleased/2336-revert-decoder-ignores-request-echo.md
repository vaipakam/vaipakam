## A failed transaction's explanation no longer mistakes the request for the error (PR #2338)

When a transaction fails, the app reads the error the contract reported and
turns it into a plain-language explanation. The shared decoder looked for that
error in the failure message as well as in the error's own fields, and the
messages produced by the app's blockchain library also repeat the request that
was sent, including the call's own encoded arguments. Those arguments have the
same shape as an encoded error, so in some failures the decoder picked up the
request and reported it as the reason for the failure.

Two effects were reproduced with the library's own error types. When the
wallet could not estimate a transaction and the network answered only with
"exceeds max transaction gas limit", the app showed that raw text instead of
its guidance that this is not a real gas shortage and usually means a missing
approval or a stale app version. And when a call failed with a real error
nested one level down, the decoder reported the function being called instead
of that error, so no friendly explanation matched and a support string could
name the wrong code.

The decoder now reads the error's structured fields across the whole chain of
wrapped errors first, and only then falls back to message text. In that text it
discards anything matching the request the library recorded sending: the
library repeats the request in its own messages, and some network providers
repeat it in theirs. The structured error fields a network returns are taken as
the response and are not filtered, because the library's record also names
errors it could not decode, and filtering against it would throw real errors
away. Wallets that put the error only in plain message text are still read as
before.

Two cases remain that the decoder cannot tell apart from a real error: an error
from outside the library that repeats the request without the library having
recorded it, and a provider that puts the request itself into the structured
error field, which by convention carries the response. Closes #2336.
