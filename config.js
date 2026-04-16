import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
   USER_KEY: process.env.VERTEX_USER_KEY || "missing_key",
   PROJECT_ID: process.env.VERTEX_PROJECT_ID || "missing_project",
   MODEL_NAME: "gemini-2.0-flash-001",
   GOOGLE_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS || 'trim-bot-486500-h8-4b614b18f7c0.json',

   SYSTEM_INSTRUCTIONS: `أنت مساعد ذكي ودود.
ردودك عامية مصرية طبيعية ومختصرة.
هدف مساعدة المستخدم في استفساره بأفضل شكل ممكن.`
};
