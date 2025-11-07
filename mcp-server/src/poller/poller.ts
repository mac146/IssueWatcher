import { GitHubAPI } from "../github/api";
import { loadState, saveState } from "../utils/state";

export async function pollOnce(){
    
const github=new GitHubAPI();

const state= loadState();

const starredrepos=await github.getStarredRepos();

for ( const repo of starredrepos){
    const owner= repo.owner;
    const name=repo.name;
     const key = `${owner}/${name}`;

    const issues=await github.getIssues(owner,name);
    const currentIssueNumbers = issues.map(issue => issue.number);
    const previousIssueNumbers = state[key] || [];
    const newIssueNumbers =
      currentIssueNumbers.filter(num => !previousIssueNumbers.includes(num));

    if (newIssueNumbers.length > 0) {
      console.log(`NEW ISSUES in ${owner}/${name}`);

      newIssueNumbers.forEach(num => {
        const issue = issues.find(i => i.number === num);
        console.log(`- Issue #${issue.number} by @${issue.user}: ${issue.title}`);
      });
    }

    state[key] = currentIssueNumbers;
}
saveState(state);

}
