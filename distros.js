// Shared by the content script, background worker, options page and tests.

// Ordered oldest -> newest. Rolling is always last.
//   docs: has main documentation at docs.ros.org/en/<id>/
//   api:  where package API docs live — "legacy" = docs.ros2.org/<id>/api/<pkg>/,
//         "rosdoc2" = docs.ros.org/en/<id>/p/<pkg>/
const ROS2_DISTROS = [
  { id: "ardent", name: "Ardent Apalone", docs: false, api: "legacy" },
  { id: "bouncy", name: "Bouncy Bolson", docs: false, api: "legacy" },
  { id: "crystal", name: "Crystal Clemmys", docs: true, api: "legacy" },
  { id: "dashing", name: "Dashing Diademata", docs: true, api: "legacy" },
  { id: "eloquent", name: "Eloquent Elusor", docs: true, api: "legacy" },
  { id: "foxy", name: "Foxy Fitzroy", docs: true, api: "legacy" },
  { id: "galactic", name: "Galactic Geochelone", docs: true, api: "legacy" },
  { id: "humble", name: "Humble Hawksbill", docs: true, api: "rosdoc2" },
  { id: "iron", name: "Iron Irwini", docs: true, api: "rosdoc2" },
  { id: "jazzy", name: "Jazzy Jalisco", docs: true, api: "rosdoc2" },
  { id: "kilted", name: "Kilted Kaiju", docs: true, api: "rosdoc2" },
  { id: "lyrical", name: "Lyrical Luth", docs: true, api: "rosdoc2" },
  { id: "rolling", name: "Rolling Ridley", docs: true, api: "rosdoc2" },
];

const DISTRO_IDS = ROS2_DISTROS.map((d) => d.id);

// docs.ros2.org/latest/ is a copy of the Foxy API docs.
const LEGACY_ALIASES = { latest: "foxy" };

// ROS 1 distros, oldest -> newest. Only their package API docs are on
// docs.ros.org (/en/<id>/api/<pkg>/html/); those pages go to the same package in
// the target ROS 2 distro. They're not in DISTRO_IDS, so distroIndex() places
// them before every ROS 2 distro.
const ROS1_DISTRO_IDS = [
  "diamondback", "electric", "fuerte", "groovy", "hydro", "indigo",
  "jade", "kinetic", "lunar", "melodic", "noetic",
];

// docs.ros.org/en/api/ and these trees are copies of the Noetic API docs.
const ROS1_ALIASES = { latest: "noetic", "latest-lts": "noetic", "latest-available": "noetic" };

const DEFAULT_SETTINGS = {
  targetDistro: "jazzy",
  mode: "delayed", // "auto" | "delayed" | "manual" | "off"
  delaySeconds: 5,
  verifyExists: true,
  redirectFromNewer: true,
  redirectFromRos1: true,
};

function getDistro(id) {
  return ROS2_DISTROS.find((d) => d.id === id);
}

function distroIndex(id) {
  return DISTRO_IDS.indexOf(id);
}

function distroLabel(id) {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

// Describes a distro-versioned ROS 2 docs page, or returns null. Shapes:
//   { kind: "docs", distro, rest }                        main docs page
//   { kind: "pkg", distro, layout, pkg, rest }            package API docs page
//                                                         (layout: "rosdoc2" | "legacy" | "ros1")
//   { kind: "pkgindex", distro }                          list of all packages
// `rest` is the path below the distro/package root; all shapes carry search + hash.
function parseDocsUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const p = url.pathname.split("/"); // ["", "en", "jazzy", ...]
  const extra = { search: url.search, hash: url.hash };
  const pkgPage = (distro, layout, i) =>
    p[i]
      ? { kind: "pkg", distro, layout, pkg: p[i], rest: p.slice(i + 1).join("/"), ...extra }
      : { kind: "pkgindex", distro, ...extra };

  if (url.hostname === "docs.ros.org" && p[1] === "en") {
    // Mirror of the rosdoc2 docs: /en/ros2_packages/<distro>/api/<pkg>/...
    if (p[2] === "ros2_packages" && DISTRO_IDS.includes(p[3]) && p[4] === "api") {
      return pkgPage(p[3], "rosdoc2", 5);
    }
    if (DISTRO_IDS.includes(p[2])) {
      if (p[3] === "p") return pkgPage(p[2], "rosdoc2", 4);
      return { kind: "docs", distro: p[2], rest: p.slice(3).join("/"), ...extra };
    }
    // ROS 1 package docs: /en/<distro>/api/<pkg>/html/..., or /en/api/<pkg>/html/... (Noetic)
    const [ros1, apiAt] = p[2] === "api" ? ["noetic", 2] : [ROS1_ALIASES[p[2]] ?? p[2], 3];
    if (ROS1_DISTRO_IDS.includes(ros1) && p[apiAt] === "api") return pkgPage(ros1, "ros1", apiAt + 1);
  }

  if (url.hostname === "docs.ros2.org") {
    const distro = LEGACY_ALIASES[p[1]] ?? p[1];
    if (DISTRO_IDS.includes(distro) && p[2] === "api") return pkgPage(distro, "legacy", 3);
  }

  return null;
}
