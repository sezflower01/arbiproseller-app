
// TEMPORARY preview-only route for reviewing PlatformModulesShowcase before it's wired into the real landing page.
// Delete this file (and its route in App.tsx) once the review is done.
import PlatformModulesShowcase from "@/components/PlatformModulesShowcase";

const PreviewModulesShowcase = () => (
  <div className="min-h-screen bg-[hsl(222,84%,4.9%)]">
    <PlatformModulesShowcase />
  </div>
);

export default PreviewModulesShowcase;
