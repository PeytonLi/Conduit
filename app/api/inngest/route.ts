import { serve } from "inngest/next";
import { functions, inngest } from "@/lib/workflows";

export const { GET, POST, PUT } = serve({ client: inngest, functions });
