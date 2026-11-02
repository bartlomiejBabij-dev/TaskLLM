import { WorkflowBuilder } from '@/components/workflow-builder';
export default async function NewWorkflow({searchParams}:{searchParams:Promise<{template?:string}>}) {return <WorkflowBuilder templateId={(await searchParams).template}/>;}
