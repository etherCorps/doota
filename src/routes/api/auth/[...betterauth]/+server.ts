import type { RequestHandler } from "@sveltejs/kit";

export const GET: RequestHandler = async (event) => {
 return event.locals.auth.handler(event.request);
};
export const POST: RequestHandler = async (event) => {
 return event.locals.auth.handler(event.request);
};
export const PUT: RequestHandler = async (event) => {
 return event.locals.auth.handler(event.request);
};
export const DELETE: RequestHandler = async (event) => {
 return event.locals.auth.handler(event.request);
};
