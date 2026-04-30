## Fix the Broken Git

if `git` got borken then run the following command
Ref: https://stackoverflow.com/questions/11706215/how-can-i-fix-the-git-error-object-file-is-empty

```bash
find .git/objects/ -type f -empty -delete
git fetch -p
git fsck --full
```
