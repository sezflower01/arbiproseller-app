
import type { Config } from "tailwindcss";

export default {
	darkMode: ["class"],
	content: [
		"./pages/**/*.{ts,tsx}",
		"./components/**/*.{ts,tsx}",
		"./app/**/*.{ts,tsx}",
		"./src/**/*.{ts,tsx}",
	],
	prefix: "",
	theme: {
		container: {
			center: true,
			padding: '1rem',
			screens: {
				'2xl': '1920px'
			}
		},
		extend: {
			colors: {
				border: 'hsl(var(--border))',
				input: 'hsl(var(--input))',
				ring: 'hsl(var(--ring))',
				background: 'hsl(var(--background))',
				foreground: 'hsl(var(--foreground))',
				primary: {
					DEFAULT: 'hsl(var(--primary))',
					foreground: 'hsl(var(--primary-foreground))'
				},
				secondary: {
					DEFAULT: 'hsl(var(--secondary))',
					foreground: 'hsl(var(--secondary-foreground))'
				},
				destructive: {
					DEFAULT: 'hsl(var(--destructive))',
					foreground: 'hsl(var(--destructive-foreground))'
				},
				success: {
					DEFAULT: 'hsl(var(--success))',
					foreground: 'hsl(var(--success-foreground))'
				},
				muted: {
					DEFAULT: 'hsl(var(--muted))',
					foreground: 'hsl(var(--muted-foreground))'
				},
				accent: {
					DEFAULT: 'hsl(var(--accent))',
					foreground: 'hsl(var(--accent-foreground))'
				},
				popover: {
					DEFAULT: 'hsl(var(--popover))',
					foreground: 'hsl(var(--popover-foreground))'
				},
				card: {
					DEFAULT: 'hsl(var(--card))',
					foreground: 'hsl(var(--card-foreground))'
				},
				'table-row': {
					DEFAULT: 'hsl(var(--table-row))',
					alt: 'hsl(var(--table-row-alt))',
					hover: 'hsl(var(--table-row-hover))'
				},
				'row-tint': {
					DEFAULT: 'hsl(var(--row-tint))',
					alt: 'hsl(var(--row-tint-alt))',
					hover: 'hsl(var(--row-tint-hover))'
				},
				shipment: {
					surface: 'hsl(var(--shipment-surface))',
					'elevated': 'hsl(var(--shipment-surface-elevated))',
					control: 'hsl(var(--shipment-control))',
					row: 'hsl(var(--shipment-row))',
					'row-alt': 'hsl(var(--shipment-row-alt))',
					'row-hover': 'hsl(var(--shipment-row-hover))'
				},
				sidebar: {
					DEFAULT: 'hsl(var(--sidebar-background))',
					foreground: 'hsl(var(--sidebar-foreground))',
					primary: 'hsl(var(--sidebar-primary))',
					'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
					accent: 'hsl(var(--sidebar-accent))',
					'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
					border: 'hsl(var(--sidebar-border))',
					ring: 'hsl(var(--sidebar-ring))'
				},
				brand: {
					50: '#f0f9ff',
					100: '#e0f2fe',
					200: '#b9e5fe',
					300: '#7cd1fd',
					400: '#36b9fa',
					500: '#0c9fe8',
					600: '#017fc8',
					700: '#0266a3',
					800: '#065786',
					900: '#0a4970',
					950: '#062d48',
				},
				purple: {
					50: '#f5f3ff',
					100: '#ede9fe',
					200: '#ddd6fe',
					300: '#c4b5fd',
					400: '#a78bfa',
					500: '#8b5cf6',
					600: '#7c3aed',
					700: '#6d28d9',
					800: '#5b21b6',
					900: '#4c1d95',
					950: '#2e1065',
				}
			},
			borderRadius: {
				lg: 'var(--radius)',
				md: 'calc(var(--radius) - 2px)',
				sm: 'calc(var(--radius) - 4px)'
			},
			fontFamily: {
				'ih-sans': ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
				'ih-display': ['var(--font-display)', 'ui-sans-serif', 'system-ui', 'sans-serif']
			},
			keyframes: {
				'accordion-down': {
					from: {
						height: '0'
					},
					to: {
						height: 'var(--radix-accordion-content-height)'
					}
				},
				'accordion-up': {
					from: {
						height: 'var(--radix-accordion-content-height)'
					},
					to: {
						height: '0'
					}
				},
				fadeIn: {
					from: { opacity: '0' },
					to: { opacity: '1' }
				},
				slideUp: {
					from: { transform: 'translateY(10px)', opacity: '0' },
					to: { transform: 'translateY(0)', opacity: '1' }
				},
				'bounce-slow': {
					'0%, 100%': { transform: 'translateY(-4%)' },
					'50%': { transform: 'translateY(0)' }
				}
			},
			animation: {
				'accordion-down': 'accordion-down 0.2s ease-out',
				'accordion-up': 'accordion-up 0.2s ease-out',
			'fade-in': 'fadeIn 0.5s ease-out',
			'slide-up': 'slideUp 0.5s ease-out',
			'bounce-slow': 'bounce-slow 14s ease-in-out infinite'
			}
		}
	},
	plugins: [require("tailwindcss-animate")],
} satisfies Config;
