import { chromium } from '@playwright/test'
const B='http://localhost:3000', out='screenshots/'
const b = await chromium.launch(); 
async function ctx(){ return (await b.newContext({viewport:{width:1280,height:800}})).newPage() }
async function login(p,id,pw){ await p.goto(B+'/login'); await p.getByLabel('Phone or email').fill(id); await p.getByLabel('Password').fill(pw); await p.getByRole('button',{name:'Log in'}).click(); await p.waitForLoadState('networkidle') }
const shot=async(p,n)=>{await p.waitForTimeout(500);await p.screenshot({path:out+n+'.png',fullPage:true})}
// platform admin
let p=await ctx(); await p.goto(B+'/login'); await shot(p,'01-login')
await login(p,'demoadmin@shot.test','Shot-Admin-7391!'); await shot(p,'02-platform')
// owner
p=await ctx(); await login(p,'shotowner@shot.test','Shot-Temp-4821!'); await shot(p,'03-change-password')
await p.getByLabel('Current password').fill('Shot-Temp-4821!')
await p.getByLabel('New password (at least 8 characters)').fill('Shot-Owner-9917!')
await p.getByLabel('Confirm new password').fill('Shot-Owner-9917!')
await p.getByRole('button',{name:'Change password'}).click(); await p.waitForURL('**/admin'); await shot(p,'04-admin-overview')
await p.goto(B+'/admin/outlets')
const of=p.locator('form').filter({has:p.getByRole('button',{name:'Create outlet'})})
await of.getByLabel('Outlet name').fill('Kitale'); await of.getByLabel('Code (2 to 5 letters or digits)').fill('KTL'); await of.getByRole('button',{name:'Create outlet'}).click(); await p.getByText('KTL',{exact:true}).waitFor(); await shot(p,'05-outlets')
await p.goto(B+'/admin/staff')
const sf=p.locator('form').filter({has:p.getByRole('button',{name:'Add staff member'})})
await sf.getByLabel('Name',{exact:true}).fill('Jane'); await sf.getByLabel('Role').selectOption('cashier'); await sf.getByLabel('Phone (or email)').fill('0712345678'); await sf.getByLabel('Temporary password (min 8 characters)').fill('Temp-Cash-5532'); await sf.getByLabel('KTL · Kitale').check(); await sf.getByRole('button',{name:'Add staff member'}).click()
await p.getByText('Outlets: KTL').waitFor(); await shot(p,'06-staff')
await p.goto(B+'/till'); await shot(p,'07-till-owner')
// bad login
p=await ctx(); await login(p,'nobody@shot.test','wrong-pass-1'); await shot(p,'08-login-error')
await b.close()
