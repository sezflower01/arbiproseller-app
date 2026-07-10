ALTER TABLE public.chat_messages DROP CONSTRAINT chat_messages_sender_role_check;
ALTER TABLE public.chat_messages ADD CONSTRAINT chat_messages_sender_role_check CHECK (sender_role IN ('user', 'admin', 'system'));
ALTER TABLE public.chat_messages ALTER COLUMN sender_id DROP NOT NULL;