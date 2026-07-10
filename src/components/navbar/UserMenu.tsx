import { useState, useEffect } from 'react';
import { LogOut, User, Mail, Settings } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';

export default function UserMenu() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    supabase
      .from('organization_settings')
      .select('logo_url')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.logo_url) setLogoUrl(data.logo_url);
      });
  }, [user]);

  const handleSignOut = async () => {
    await signOut();
    toast({
      title: "Logged out",
      description: "You've been successfully logged out",
    });
    navigate('/');
  };

  if (!user) return null;

  const firstName = user.user_metadata?.first_name || user.email?.split('@')[0] || 'User';
  const lastName = user.user_metadata?.last_name || '';
  const displayName = lastName ? `${firstName} ${lastName}` : firstName;
  const initials = lastName
    ? `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase()
    : firstName.slice(0, 2).toUpperCase();

  const AvatarCircle = ({ size = 'sm' }: { size?: 'sm' | 'lg' }) => {
    const dims = size === 'sm' ? 'h-7 w-7' : 'h-10 w-10';
    const textSize = size === 'sm' ? 'text-[11px]' : 'text-sm';
    if (logoUrl) {
      return <img src={logoUrl} alt="Logo" className={`${dims} rounded-full object-cover`} />;
    }
    return (
      <div className={`flex ${dims} items-center justify-center rounded-full bg-gradient-to-br from-primary ${size === 'lg' ? 'via-primary/80 to-primary/50 shadow-lg shadow-primary/20' : 'to-primary/60'} ${textSize} font-bold text-primary-foreground`}>
        {initials}
      </div>
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="group gap-2 h-10 rounded-xl border border-white/15 bg-white/5 px-3 text-white font-semibold backdrop-blur-xl shadow-[0_4px_20px_-4px_hsl(var(--primary)/0.3),inset_0_1px_0_0_rgba(255,255,255,0.1)] transition-all duration-300 hover:-translate-y-0.5 hover:bg-white/10 hover:border-primary/40 hover:text-white hover:shadow-[0_10px_30px_-6px_hsl(var(--primary)/0.5),inset_0_1px_0_0_rgba(255,255,255,0.15)]"
        >
          <AvatarCircle size="sm" />
          <span className="hidden md:inline">{displayName}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-64 rounded-2xl border border-white/15 bg-[hsl(222,84%,4.9%)]/80 p-0 shadow-[0_20px_60px_-10px_hsl(var(--primary)/0.4),inset_0_1px_0_0_rgba(255,255,255,0.08)] backdrop-blur-2xl"
      >
        {/* Header with avatar & info */}
        <div className="flex items-center gap-3 px-4 py-4 border-b border-white/10">
          <AvatarCircle size="lg" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">{displayName}</p>
            <p className="truncate text-xs text-gray-400">{user.email}</p>
          </div>
        </div>

        {/* Menu items */}
        <div className="p-1.5">
          <DropdownMenuItem
            onClick={() => navigate('/settings')}
            className="cursor-pointer gap-3 rounded-lg px-3 py-2.5 text-gray-300 hover:text-white focus:bg-white/5 focus:text-white"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/5">
              <User className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="text-sm font-medium">Settings</p>
              <p className="text-[11px] text-gray-500">Account settings</p>
            </div>
          </DropdownMenuItem>

          <DropdownMenuItem
            onClick={() => {
              if (user.email) {
                window.location.href = `mailto:${user.email}`;
              }
            }}
            className="cursor-pointer gap-3 rounded-lg px-3 py-2.5 text-gray-300 hover:text-white focus:bg-white/5 focus:text-white"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/5">
              <Mail className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="text-sm font-medium">Email</p>
              <p className="text-[11px] text-gray-500 truncate max-w-[160px]">{user.email}</p>
            </div>
          </DropdownMenuItem>
        </div>

        <DropdownMenuSeparator className="bg-white/10 mx-2" />

        <div className="p-1.5">
          <DropdownMenuItem
            onClick={handleSignOut}
            className="cursor-pointer gap-3 rounded-lg px-3 py-2.5 text-red-400 hover:text-red-300 focus:bg-red-500/10 focus:text-red-300"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/10">
              <LogOut className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-medium">Log out</p>
              <p className="text-[11px] text-red-400/60">End your session</p>
            </div>
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
