# Keeper names fills the Terms rule refuses (#3734)

The contracts refuse a new position for a wallet that has not accepted the
Terms of Service in force. The keeper's matching, collection-matching and
standing-intent passes now say why such a fill did not happen. On the first
refused pair they read which side is not current and name that wallet once
in the run log. For the rest of the run they pass over that wallet's other
pairs, so they do not spend previews on answers that cannot change until
the wallet accepts.

The keeper never records an acceptance for anyone. A wallet whose standing
cannot be read is not passed over, and the log says so.
