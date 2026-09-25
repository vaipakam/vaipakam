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
wrapped errors first, and only then falls back to message text. In both places
it discards anything matching the request the library recorded sending: the
library repeats the request in its own messages, and a network provider can
repeat it in its error text or in its error data. The library's notes are not
only about the request, since it also names an error it could not decode
there; such a note is recognised because the same error carries those bytes as
its own data, so real errors are kept. Wallets that put the error only in plain
message text are still read as before.

One case remains that the decoder cannot tell apart from a real error: an error
from outside the library that repeats the request, when the library recorded no
copy of the request to compare it with. Closes #2336.
