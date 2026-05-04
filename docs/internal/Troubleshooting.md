## Fix the Broken Git

if `git` got borken then run the following command
Ref: https://stackoverflow.com/questions/11706215/how-can-i-fix-the-git-error-object-file-is-empty

```bash
find .git/objects/ -type f -empty -delete
git fetch -p
git fsck --full
```

## To softly remove top N commits from local

`git reset --soft HEAD~N`

replace N with number of top commits that need to be reverted

## To untrack a file, in case if its added to gitignore

`git rm --cached docs/internal/RoughNotes.md`
