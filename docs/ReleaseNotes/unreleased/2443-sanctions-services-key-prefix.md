## Thread — Sanctions services accept a signing key with or without 0x (PR #2593)

The sanctions adder and delister now accept their signing key written with or without the 0x prefix, and with spaces around it, the same forms the keeper accepts for its own key. Before, a key copied the way the keeper's settings file holds it was refused outright, which stopped the adder's first run on the keeper machine before it downloaded or sent anything. A malformed key is still refused, and the message still never quotes it.

The services always sign with the prefixed form, and the redaction that cleans every report, journal line and ops alert now removes the key's digits whichever way they were written, so neither form can leak. Both settings templates now say which forms are accepted. Refs #2443.
