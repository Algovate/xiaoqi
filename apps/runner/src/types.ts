export interface Task {
  id: string;
  account_id: string;
  user_id: string | null;
  conversation_key: string;
  repo_alias: string;
  repo_path: string;
  prompt: string;
  engine: string;
  kind: string;
  resume_session_id: string | null;
  status: string;
}
