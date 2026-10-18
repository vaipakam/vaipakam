## Sanctions adder — a refused download leaves nothing behind

The adder's download tool writes the OFAC publication to a partial file and
renames it only once the whole body has arrived; a download it refuses (the
server answers with an error, the body exceeds the size cap, the file cannot
be written) removes the partial file before reporting the refusal. The
removal ran before the file had necessarily been created: the write stream
opens its file in the background, so a refusal that arrived first saw the
partial file appear after it had been removed. The tool now waits for the
stream to close before removing, so a refused download leaves nothing on
disk. This showed up as an intermittent failure of the tool's own test in
CI, on a change that did not touch it.

Refs #2443.
