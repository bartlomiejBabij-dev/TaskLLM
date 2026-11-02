import {test,expect} from '@playwright/test';
test('register, log in, configure AI, save, execute, schedule and inspect persisted results',async({page})=>{
 const email=`test-${Date.now()}@example.test`;const password='TestPassword123!';
 await page.goto('/signup');await page.getByLabel('Full name').fill('Test User');await page.getByLabel('Email address').fill(email);await page.getByLabel(/^Password/).fill(password);await page.getByRole('button',{name:'Create account'}).click();
 await expect(page.getByRole('heading',{name:'Workspace overview'})).toBeVisible();
 await page.request.post('/api/auth',{headers:{origin:'http://localhost:3001'},data:{action:'logout'}});
 await page.goto('/login');await page.getByLabel('Email address').fill(email);await page.getByLabel(/^Password/).fill(password);await page.getByRole('button',{name:'Log in',exact:true}).click();await expect(page).toHaveURL(/dashboard/);
 await page.goto('/workflows/new');await page.getByRole('textbox',{name:'Workflow name',exact:true}).fill('Customer feedback');await page.getByRole('textbox',{name:'Input text',exact:true}).fill('Customers love the quick delivery.');
 await page.getByRole('button',{name:'Add AI prompt',exact:true}).click();await page.getByRole('textbox',{name:'Prompt',exact:true}).fill('Summarize the customer feedback.');await page.getByRole('combobox',{name:/Billing mode/}).selectOption('managed');
 await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.getByText('All changes saved',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Run workflow',exact:true}).click();await expect(page.locator('.builder-run-status .status-completed')).toBeVisible({timeout:30000});
 await page.getByRole('link',{name:'View results'}).click();await expect(page.getByText('Fixture AI response: customer feedback is positive.',{exact:false}).last()).toBeVisible();
 const workflows=await (await page.request.get('/api/workflows')).json();const workflowId=workflows.data[0].id;
 const scheduled=await page.request.post('/api/schedules',{headers:{origin:'http://localhost:3001'},data:{workflow_id:workflowId,cron:'0 9 * * *',timezone:'Europe/Warsaw'}});expect(scheduled.status()).toBe(201);
 await page.goto('/schedules');await expect(page.getByText('Customer feedback').first()).toBeVisible();
 await page.goto('/executions');await expect(page.getByText('Customer feedback').first()).toBeVisible();
 await page.goto('/usage');await expect(page.getByRole('heading',{level:1})).toBeVisible();
 await page.screenshot({path:'test-results/workspace.png',fullPage:true});
});
test('public page is usable on mobile and private APIs reject anonymous access',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/');await expect(page.getByRole('heading',{level:1})).toContainText('autopilot');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
 expect((await page.request.get('/api/workflows')).status()).toBe(401);
 await page.screenshot({path:'test-results/landing-mobile.png',fullPage:true});
});



