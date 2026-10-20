import { db } from '@/db/client'
import { cronAuthorized, runJobs } from '@/server/jobs'

/** Called every minute by the cron container with `Authorization: Bearer $CRON_SECRET`. */
export async function POST(request: Request) {
  if (!cronAuthorized(request.headers.get('authorization'))) return new Response(null, { status: 401 })
  return Response.json(await runJobs(db))
}
