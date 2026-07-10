
import React from "react";
import { cn } from "@/lib/utils";

interface CodeProps {
  children: React.ReactNode;
  className?: string;
}

export function Code({ children, className }: CodeProps) {
  return (
    <pre className={cn("bg-gray-900 text-gray-100 p-5 rounded-md my-4 overflow-x-auto", className)}>
      <code>{children}</code>
    </pre>
  );
}
