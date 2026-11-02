import { WorkflowBuilder } from '@/components/workflow-builder';
export default async function EditWorkflow({params}:{params:Promise<{id:string}>}) {return <WorkflowBuilder workflowId={(await params).id}/>;}
