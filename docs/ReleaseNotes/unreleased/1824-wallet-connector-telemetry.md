## Two wallet apps stop reporting visitors to their wallet vendors

Wallet connection kits ship with their own analytics built in, reporting back to
the vendor unless an application explicitly turns them off. The project's rules
already require that they be turned off, so a visitor is not reported on for
usage they never agreed to, and so that people on restricted networks are not
subjected to a stream of failed background requests.

One of the three wallet-connecting apps had done this. The other two had not —
the requirement had simply never been applied to them, and nothing checked. Both
now switch the reporting off, using exactly the settings the working app already
uses.

### It was not only about the connect dialog

The rule was written as though the exposure begins when someone opens the wallet
dialog. It does not. These apps try to restore a previous wallet session as soon
as they load, and doing that means constructing every configured connector to
ask whether it has one — which is the moment each kit's reporting starts. So the
reporting covered every visitor to those two apps, including people who never
went near a wallet.

The two kits also behaved differently once switched on, which is worth recording
because it made the problem easy to misjudge from the outside. One reports on
each page load. The other reports nothing on a first visit and only forwards
activity that an earlier session had left stored — quieter, but on, and one
routine dependency update away from becoming as loud as the first.

### Why leaving the setting out was not the same as switching it off

For one of the two kits, omitting the setting and setting it to "off" look
identical in the source and are opposite in effect: the library treats an absent
setting as a request for its default, and its default is on. That behaviour also
changed between two adjacent patch versions of the same library, so reading a
copy that happened to be lying around gave the opposite answer to reading the
one the app actually uses. The settings are now written out explicitly in both
apps rather than left to a default nobody controls.
