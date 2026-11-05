import { createHandler } from './handler.mjs';

// ERP has its own expiring personal sessions. The handler validates them using
// the existing permission-protected attendance RPC before any Kakao request.
Deno.serve(createHandler({env:(name:string)=>Deno.env.get(name)}));
