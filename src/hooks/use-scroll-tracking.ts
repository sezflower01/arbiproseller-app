
import { useEffect, useRef } from 'react';

export const useScrollTracking = () => {
  const scrollDepthTracked = useRef<Set<number>>(new Set());
  const timeOnPageStart = useRef<number>(Date.now());

  useEffect(() => {
    const handleScroll = () => {
      const scrollPercent = Math.round(
        (window.scrollY / (document.documentElement.scrollHeight - window.innerHeight)) * 100
      );

      // Track scroll depth milestones
      const milestones = [25, 50, 75, 90];
      milestones.forEach(milestone => {
        if (scrollPercent >= milestone && !scrollDepthTracked.current.has(milestone)) {
          scrollDepthTracked.current.add(milestone);
          
          if (typeof gtag !== 'undefined') {
            gtag('event', 'scroll', {
              event_category: 'engagement',
              event_label: `scroll_depth_${milestone}`,
              value: milestone
            });
          }
        }
      });
    };

    const handleBeforeUnload = () => {
      const timeOnPage = Math.round((Date.now() - timeOnPageStart.current) / 1000);
      
      if (typeof gtag !== 'undefined') {
        gtag('event', 'page_view_duration', {
          event_category: 'engagement',
          event_label: 'time_on_page',
          value: timeOnPage
        });
      }
    };

    window.addEventListener('scroll', handleScroll);
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);
};
