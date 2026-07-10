
DROP POLICY "Participants can send messages" ON public.chat_messages;
CREATE POLICY "Participants can send messages"
  ON public.chat_messages FOR INSERT TO authenticated
  WITH CHECK (
    (sender_id = auth.uid() OR (sender_role = 'system' AND public.has_role(auth.uid(), 'admin')))
    AND EXISTS (
      SELECT 1 FROM public.chat_sessions cs
      WHERE cs.id = session_id
        AND (cs.user_id = auth.uid() OR cs.admin_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
    )
  );
