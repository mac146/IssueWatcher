import axios, {AxiosInstance} from "axios";
import { env } from "process";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

export class GitHubAPI {
  private client: AxiosInstance;

  
  constructor() {
    
    this.client = axios.create({
      baseURL: "https://api.github.com",
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        "User-Agent": "IssueWatcher-MCP",
      },
    });
  }

  async getStarredRepos(): Promise<any[]> {
    try{
        const response= await this.client.get("/user/starred")

        const simplified = response.data.map((repo: any) => ({
          name: repo.name,
          owner: repo.owner.login,
           url: repo.html_url,
          description: repo.description,
    }));
    
        return simplified;
    } catch(err){
        console.error("Error fetching starred repos:", err);
        return [];
    }
  }

  async getIssues(owner:string, repo:string): Promise<any[]>{
    try{
        const response= await this.client.get(`/repos/${owner}/${repo}/issues`);
        const simplified= response.data.map((issue:any) => ({
           id: issue.id,
           number: issue.number,
           title: issue.title,
           url: issue.html_url,
           state: issue.state,
           createdAt: issue.created_at,
           user: issue.user?.login
        }))

         return simplified;
         
    } catch(err){
        console.error("Error fetching starred repos:", err);
        return [];
    }
  }

  
} 