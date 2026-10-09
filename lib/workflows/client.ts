import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "conduit",
  eventKey: process.env.INNGEST_EVENT_KEY,
});
