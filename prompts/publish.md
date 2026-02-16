You are a senior software engineer finalizing work in $REPO_PATH (an isolated git worktree).

1. Get the current branch name and issue title:
   cd $REPO_PATH && BRANCH=$(git branch --show-current)
   ISSUE_TITLE=$(gh issue view $ISSUE_NUMBER --repo $REPO_SLUG --json title --jq .title)

2. Stage any remaining changes (from review fixes) and commit:
   cd $REPO_PATH && git add -A -- ':!.factory'
   # Only commit if there are staged changes
   git diff --cached --quiet || git commit -m "fix: address review feedback for #$ISSUE_NUMBER"

3. Push the branch:
   git push -u origin $BRANCH

4. Read $REPO_PATH/.factory/review.md for the PR body.

5. Open a pull request using the actual issue title:
   gh pr create --repo $REPO_SLUG --base main --head $BRANCH \
     --title "$ISSUE_TITLE (#$ISSUE_NUMBER)" \
     --body "Closes #$ISSUE_NUMBER

$(cat $REPO_PATH/.factory/review.md)"

6. Clean up artifacts:
   rm -rf $REPO_PATH/.factory

7. Output the PR URL.
