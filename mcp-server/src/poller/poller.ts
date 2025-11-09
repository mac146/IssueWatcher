import { GitHubAPI } from "../github/api.js";
import { loadState, saveState } from "../utils/state.js";
import { Issue } from "./types.js";
export async function pollOnce(){
    
const github=new GitHubAPI();

const state= loadState();

const starredrepos=await github.getStarredRepos();

const allNewIssues : Issue[]=[];

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

        allNewIssues.push({
        repo: `${owner}/${name}`,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        user: issue.user,
        url: issue.html_url,
        labels: issue.labels
       });
      });
    }

    state[key] = currentIssueNumbers;
}
saveState(state);

return allNewIssues;

}
