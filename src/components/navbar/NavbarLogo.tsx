
import React from 'react';

const ICON_SRC = "/logo-icon.png";

interface NavbarLogoProps {
  onClick: () => void;
}

const NavbarLogo: React.FC<NavbarLogoProps> = ({ onClick }) => (
  <a onClick={onClick} className="flex items-center cursor-pointer">
    <img
      src={ICON_SRC}
      alt="Inventory S.P.R.I.N.T. Logo"
      className="h-9 w-auto mr-3"
    />
    <span className="text-2xl font-bold text-blue-600">Inventory S.P.R.I.N.T.</span>
  </a>
);

export default NavbarLogo;
