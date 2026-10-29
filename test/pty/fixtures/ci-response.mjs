import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export function ciResponse(path){
  const match=/^repos\/([^/]+\/[^/]+)\/actions\/runs\/([1-9][0-9]*)(\?exclude_pull_requests=true|\/attempts\/([1-9][0-9]*)\/jobs\?per_page=100&page=1)$/.exec(path??'');
  if(!match)return null;
  const repository=match[1],id=Number(match[2]);
  const selected=JSON.parse(readFileSync(new URL('./actions-runs.json',import.meta.url))).find(run=>run.databaseId===id);
  if(!selected)return null;
  const sha='a'.repeat(40);
  if(match[4])return {total_count:2,jobs:[{id:id*10+1,run_id:id,head_sha:sha,name:'unit tests',status:'completed',conclusion:selected.conclusion==='failure'?'failure':'success',html_url:`https://github.com/${repository}/actions/runs/${id}/job/${id*10+1}`,steps:[{number:1,name:'Run tests',status:'completed',conclusion:selected.conclusion==='failure'?'failure':'success'}]},{id:id*10+2,run_id:id,head_sha:sha,name:'canceled check',status:'completed',conclusion:'cancelled',html_url:`https://github.com/${repository}/actions/runs/${id}/job/${id*10+2}`,steps:[]}]};
  return {id,repository:{full_name:repository},run_attempt:1,head_sha:sha,status:selected.status,conclusion:selected.conclusion,updated_at:selected.updatedAt,html_url:selected.url};
}
if(process.argv[1]===fileURLToPath(import.meta.url))process.stdout.write(JSON.stringify(ciResponse(process.argv[2]))+'\n');
