// The touch panel's menu items. The admin can hide the ones a venue doesn't
// use (Touch panel page); ids match TABS in src/engine/site.ts.
// Each icon is the `d` of one 24x24 stroked path.
export const TABS = [
  { id: "scenes", label: "Scenes", icon: "M12 3l2.3 6.2L20.5 11.5l-6.2 2.3L12 20l-2.3-6.2L3.5 11.5l6.2-2.3z" },
  { id: "walls", label: "Video Walls", icon: "M3 5h18v13H3zM12 5v13M3 11.5h18" },
  { id: "rooms", label: "Rooms", icon: "M4 11l8-6.5 8 6.5v8.5H4zM10 19.5v-5h4v5" },
  { id: "audio", label: "Audio", icon: "M4 9.5h3.5L12 5.500v13L7.500 14.500H4zM15.500 9a4 4 0 0 1 0 6M18 6.500a7.500 7.500 0 0 1 0 11" },
  { id: "remote", label: "Remote", icon: "M9 2.5h6a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H9A1.5 1.5 0 0 1 7.500 20V4A1.5 1.5 0 0 1 9 2.500zM12 6.500v3M10.500 8h3M10.500 14h.01M13.500 14h.01M10.500 17.500h.01M13.500 17.500h.01" },
  { id: "guide", label: "TV Guide", icon: "M3 5h18v14H3zM3 10h18M9 10v9M3 14.500h18" },
] as const;

export type TabId = (typeof TABS)[number]["id"];
