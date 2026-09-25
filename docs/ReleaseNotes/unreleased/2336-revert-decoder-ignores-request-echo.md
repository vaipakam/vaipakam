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
wrapped errors first, and only then falls back to message text. For the
library's errors it reads only the part of the text that describes the
response, never the part that repeats the request, and it also discards
anything in that response text that matches the request the library recorded
sending, since some network providers repeat the request in their own error
message. Wallets that put the error only in plain message text are still read
as before. One case remains: an error from outside the library that repeats
the request without the library having recorded it cannot be told apart from
a real error. Closes #2336.
