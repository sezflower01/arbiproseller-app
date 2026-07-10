import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ReactNode, MouseEvent } from 'react';
import { useAuth } from '@/contexts/AuthContext';

type Props = {
  to: string;
  children: ReactNode;
  className?: string;
  onClick?: (e?: MouseEvent<HTMLAnchorElement>) => void;
};

export default function RequireAuthLink({ to, children, className, onClick }: Props) {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!user) {
      e.preventDefault();
      if (onClick) onClick(e);
      navigate('/signup', { replace: false, state: { from: location, redirect: to } });
      return;
    }
    
    // If already on the same route, avoid a full page reload (can cause blank screen in some browsers)
    // Instead, allow callers/pages to refresh their own data via a lightweight event.
    if (location.pathname === to) {
      e.preventDefault();
      if (onClick) onClick(e);
      window.dispatchEvent(new CustomEvent('route:reselect', { detail: { path: to } }));
      return;
    }

    // if user exists, call onClick if provided, then allow normal navigation
    if (onClick) onClick(e);
  };

  return (
    <Link to={to} onClick={handleClick} className={className}>
      {children}
    </Link>
  );
}
