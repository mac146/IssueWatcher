import dotenv from "dotenv";
dotenv.config();

import { GitHubAPI } from "./github/api";


(async () => {
  const github = new GitHubAPI();
  const repos = await github.getStarredRepos();
  const issue = await github.getIssues("mac146","ArogyaCare");
  console.log(issue);
  console.log(repos);
})();
