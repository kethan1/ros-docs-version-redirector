// Live tests against docs.ros.org / docs.ros2.org. Run: node --test tests/
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const root = new URL("..", import.meta.url).pathname;
const ext = vm.createContext({ console, URL, fetch, Response, Headers, setTimeout });
for (const f of ["distros.js", "resolver.js"]) {
  vm.runInContext(fs.readFileSync(root + f, "utf8"), ext, { filename: f });
}

// Results are copied out of the vm realm so deepEqual compares plain values.
const plain = (v) => JSON.parse(JSON.stringify(v));

const resolve = async (url, target, opts) => {
  const page = ext.parseDocsUrl(url);
  assert.ok(page, `not recognised as a docs page: ${url}`);
  return plain(await ext.resolveTarget(page, target, opts));
};

async function exists(url) {
  const res = await fetch(url.split("#")[0], { method: "HEAD" });
  return res.status === 200;
}

describe("parseDocsUrl", () => {
  const cases = [
    ["https://docs.ros.org/en/foxy/Tutorials.html", { kind: "docs", distro: "foxy", rest: "Tutorials.html" }],
    ["https://docs.ros.org/en/jazzy/", { kind: "docs", distro: "jazzy", rest: "" }],
    ["https://docs.ros.org/en/jazzy/p/rclcpp/generated/x.html", { kind: "pkg", distro: "jazzy", layout: "rosdoc2", pkg: "rclcpp", rest: "generated/x.html" }],
    ["https://docs.ros.org/en/jazzy/p/rclcpp", { kind: "pkg", distro: "jazzy", layout: "rosdoc2", pkg: "rclcpp", rest: "" }],
    ["https://docs.ros.org/en/jazzy/p/", { kind: "pkgindex", distro: "jazzy" }],
    ["https://docs.ros.org/en/ros2_packages/humble/api/rclcpp/index.html", { kind: "pkg", distro: "humble", layout: "rosdoc2", pkg: "rclcpp", rest: "index.html" }],
    ["https://docs.ros2.org/foxy/api/rclcpp/classrclcpp_1_1Node.html", { kind: "pkg", distro: "foxy", layout: "legacy", pkg: "rclcpp", rest: "classrclcpp_1_1Node.html" }],
    ["https://docs.ros2.org/latest/api/rclpy/", { kind: "pkg", distro: "foxy", layout: "legacy", pkg: "rclpy", rest: "" }],
    ["https://docs.ros2.org/galactic/api/", { kind: "pkgindex", distro: "galactic" }],
    ["https://docs.ros.org/en/noetic/api/std_msgs/html/msg/Header.html", { kind: "pkg", distro: "noetic", layout: "ros1", pkg: "std_msgs", rest: "html/msg/Header.html" }],
    ["https://docs.ros.org/en/api/std_msgs/html/msg/Header.html", { kind: "pkg", distro: "noetic", layout: "ros1", pkg: "std_msgs", rest: "html/msg/Header.html" }],
    ["https://docs.ros.org/en/latest-lts/api/roscpp/html/", { kind: "pkg", distro: "noetic", layout: "ros1", pkg: "roscpp", rest: "html/" }],
    ["https://docs.ros.org/en/melodic/api/", { kind: "pkgindex", distro: "melodic" }],
  ];
  for (const [url, expected] of cases) {
    test(url, () => assert.deepEqual(plain(ext.parseDocsUrl(url)), { ...expected, search: new URL(url).search, hash: new URL(url).hash }));
  }
  for (const url of [
    "https://docs.ros.org/en/noetic/changelogs/",             // ROS 1, not API docs
    "https://docs.ros.org/en/independent/api/rospkg/html/",
    "https://docs.ros.org/en/ros2_packages/",
    "https://docs.ros.org/en/latest/",
    "https://docs.ros2.org/",
    "https://docs.ros2.org/foxy/",                            // redirects to docs.ros.org
    "https://index.ros.org/p/rclcpp/",
    "not a url",
  ]) {
    test(`ignores ${url}`, () => assert.equal(ext.parseDocsUrl(url), null));
  }
});

describe("bot-protection challenge detection", () => {
  const ANUBIS_PAGE =
    '<!doctype html><html lang="en"><head><title>Making sure you&#39;re not a bot!</title>' +
    '<link rel="stylesheet" href="/.within.website/x/xess/xess.min.css?cachebuster=v1.27.0">';
  const withFetch = async (responder, fn) => {
    const real = ext.fetch;
    ext.fetch = async (url, opts) => responder(opts?.method ?? "GET");
    try { return await fn(); } finally { ext.fetch = real; }
  };
  test("static file -> yes", () =>
    withFetch(() => new Response(null, { headers: { etag: '"abc"' } }), async () =>
      assert.equal(await ext.probe("https://docs.ros.org/en/jazzy/x.html"), "yes")));
  test("404 -> no", () =>
    withFetch(() => new Response(null, { status: 404 }), async () =>
      assert.equal(await ext.probe("https://docs.ros.org/en/jazzy/x.html"), "no")));
  test("Anubis challenge (HTTP 200) -> unknown", () =>
    withFetch((m) => new Response(m === "HEAD" ? null : ANUBIS_PAGE, { headers: { "cache-control": "no-store" } }), async () =>
      assert.equal(await ext.probe("https://docs.ros.org/en/jazzy/x.html"), "unknown")));
  test("directory listing without ETag -> yes", () =>
    withFetch((m) => new Response(m === "HEAD" ? null : "<html><title>Index of /en/jazzy/p</title>"), async () =>
      assert.equal(await ext.probe("https://docs.ros.org/en/jazzy/p/"), "yes")));
  test("network error -> unknown", () =>
    withFetch(() => { throw new TypeError("failed"); }, async () =>
      assert.equal(await ext.probe("https://docs.ros.org/en/jazzy/x.html"), "unknown")));
});

describe("main docs", () => {
  const cases = [
    {
      name: "same path keeps anchor",
      from: "https://docs.ros.org/en/foxy/Tutorials/Beginner-Client-Libraries/Writing-A-Simple-Cpp-Publisher-And-Subscriber.html#write-the-publisher-node",
      to: "jazzy",
      url: "https://docs.ros.org/en/jazzy/Tutorials/Beginner-Client-Libraries/Writing-A-Simple-Cpp-Publisher-And-Subscriber.html#write-the-publisher-node",
      confidence: "exact",
    },
    {
      name: "page moved into a subfolder (Foxy -> Jazzy)",
      from: "https://docs.ros.org/en/foxy/Concepts/About-Executors.html",
      to: "jazzy",
      url: "https://docs.ros.org/en/jazzy/Concepts/Intermediate/About-Executors.html",
      confidence: "moved",
    },
    {
      name: "Rolling restructure (Humble -> Rolling)",
      from: "https://docs.ros.org/en/humble/Concepts/Basic/About-Topics.html",
      to: "rolling",
      url: "https://docs.ros.org/en/rolling/ROS-Framework/interfaces/About-Topics.html",
      confidence: "moved",
    },
    {
      name: "Rolling restructure, reverse (Rolling -> Humble)",
      from: "https://docs.ros.org/en/rolling/ROS-Framework/interfaces/About-Topics.html",
      to: "humble",
      url: "https://docs.ros.org/en/humble/Concepts/Basic/About-Topics.html",
      confidence: "moved",
    },
    {
      name: "renamed page found by title (Foxy -> Jazzy)",
      from: "https://docs.ros.org/en/foxy/Installation/DDS-Implementations/Install-Connext-University-Eval.html",
      to: "jazzy",
      url: "https://docs.ros.org/en/jazzy/Installation/RMW-Implementations/DDS-Implementations/Working-with-RTI-Connext-DDS.html",
      confidence: "moved",
    },
    {
      name: "renamed page, similar name (fuzzy)",
      from: "https://docs.ros.org/en/foxy/Installation/Ubuntu-Install-Debians.html",
      to: "jazzy",
      url: "https://docs.ros.org/en/jazzy/Installation/Ubuntu-Install-Debs.html",
      confidence: "fuzzy",
    },
    {
      name: "action tutorial in new Rolling hierarchy",
      from: "https://docs.ros.org/en/jazzy/Tutorials/Intermediate/Writing-an-Action-Server-Client/Py.html",
      to: "lyrical",
      url: "https://docs.ros.org/en/lyrical/ROS-Framework/interfaces/actions/Working-with-actions/Writing-an-Action-Server-Client/Py.html",
      confidence: "moved",
    },
    {
      name: "distro root",
      from: "https://docs.ros.org/en/jazzy/",
      to: "humble",
      url: "https://docs.ros.org/en/humble/",
      confidence: "exact",
    },
    {
      name: "index page",
      from: "https://docs.ros.org/en/iron/index.html",
      to: "kilted",
      url: "https://docs.ros.org/en/kilted/index.html",
      confidence: "exact",
    },
    {
      name: "non-document page (genindex) checked directly",
      from: "https://docs.ros.org/en/foxy/genindex.html",
      to: "jazzy",
      url: "https://docs.ros.org/en/jazzy/genindex.html",
      confidence: "exact",
    },
    {
      name: "search page keeps query",
      from: "https://docs.ros.org/en/foxy/search.html?q=publisher",
      to: "jazzy",
      url: "https://docs.ros.org/en/jazzy/search.html?q=publisher",
      confidence: "exact",
    },
    {
      name: "old release notes still exist in new docs",
      from: "https://docs.ros.org/en/foxy/Releases/Release-Foxy-Fitzroy.html",
      to: "jazzy",
      url: "https://docs.ros.org/en/jazzy/Releases/Release-Foxy-Fitzroy.html",
      confidence: "exact",
    },
    {
      name: "newer -> older (Jazzy -> Humble)",
      from: "https://docs.ros.org/en/jazzy/How-To-Guides/Using-Variants.html",
      to: "humble",
      url: "https://docs.ros.org/en/humble/How-To-Guides/Using-Variants.html",
      confidence: "exact",
    },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      const { match } = await resolve(c.from, c.to);
      assert.ok(match, "expected a match");
      assert.equal(match.url, c.url);
      assert.equal(match.confidence, c.confidence);
      assert.ok(await exists(match.url), `destination should exist: ${match.url}`);
    });
  }

  test("removed page -> no match, offers search + home", async () => {
    const { match, fallbacks } = await resolve("https://docs.ros.org/en/foxy/Concepts/About-Catment.html", "jazzy");
    assert.equal(match, null);
    assert.deepEqual(
      fallbacks.map((f) => f.url),
      [
        "https://docs.ros.org/en/jazzy/search.html?q=On%20the%20mixing%20of%20ament%20and%20catkin%20(catment)",
        "https://docs.ros.org/en/jazzy/index.html",
      ]
    );
  });

  test("does not send a Python page to its C++ counterpart", async () => {
    const { match } = await resolve(
      "https://docs.ros.org/en/foxy/Tutorials/Intermediate/Tf2/Learning-About-Tf2-And-Time-Py.html",
      "jazzy"
    );
    assert.ok(!match || !/Cpp/i.test(match.url), `got ${match?.url}`);
  });

  test("does not confuse similarly named pages (package vs core maintainer guide)", async () => {
    const { match } = await resolve("https://docs.ros.org/en/foxy/How-To-Guides/Package-maintainer-guide.html", "jazzy");
    assert.ok(!match || !/Core-maintainer/i.test(match.url), `got ${match?.url}`);
  });

  test("smart lookup off -> plain path swap", async () => {
    const { match } = await resolve("https://docs.ros.org/en/foxy/Concepts/About-Executors.html", "jazzy", { smart: false });
    assert.deepEqual({ ...match }, { url: "https://docs.ros.org/en/jazzy/Concepts/About-Executors.html", confidence: "unverified" });
  });
});

describe("package API docs", () => {
  const cases = [
    {
      name: "legacy Doxygen class -> rosdoc2 page",
      from: "https://docs.ros2.org/foxy/api/rclcpp/classrclcpp_1_1Node.html",
      to: "jazzy",
      url: "https://docs.ros.org/en/jazzy/p/rclcpp/generated/classrclcpp_1_1Node.html",
    },
    {
      name: "legacy Doxygen member anchor -> rosdoc2 Doxygen page (anchor still valid)",
      from: "https://docs.ros2.org/foxy/api/rclcpp/classrclcpp_1_1Node.html#aac7e1fe50bc2683380cd9a635ac51edb",
      to: "jazzy",
      url: "https://docs.ros.org/en/jazzy/p/rclcpp/generated/doxygen/html/classrclcpp_1_1Node.html#aac7e1fe50bc2683380cd9a635ac51edb",
    },
    {
      name: "message definition page",
      from: "https://docs.ros2.org/foxy/api/std_msgs/msg/String.html",
      to: "jazzy",
      url: "https://docs.ros.org/en/jazzy/p/std_msgs/msg/String.html",
    },
    {
      name: "geometry_msgs message page",
      from: "https://docs.ros2.org/galactic/api/geometry_msgs/msg/Twist.html",
      to: "humble",
      url: "https://docs.ros.org/en/humble/p/geometry_msgs/msg/Twist.html",
    },
    {
      name: "rclpy Sphinx page",
      from: "https://docs.ros2.org/foxy/api/rclpy/api/node.html",
      to: "jazzy",
      url: "https://docs.ros.org/en/jazzy/p/rclpy/api/node.html",
    },
    {
      name: "legacy message package index",
      from: "https://docs.ros2.org/foxy/api/std_msgs/index-msg.html",
      to: "kilted",
      url: "https://docs.ros.org/en/kilted/p/std_msgs/",
    },
    {
      name: "docs.ros2.org/latest is Foxy",
      from: "https://docs.ros2.org/latest/api/rclcpp/",
      to: "jazzy",
      url: "https://docs.ros.org/en/jazzy/p/rclcpp/",
    },
    {
      name: "ros2_packages mirror -> canonical /p/ URL",
      from: "https://docs.ros.org/en/ros2_packages/humble/api/rclcpp/generated/classrclcpp_1_1Node.html",
      to: "jazzy",
      url: "https://docs.ros.org/en/jazzy/p/rclcpp/generated/classrclcpp_1_1Node.html",
    },
    {
      name: "rosdoc2 -> rosdoc2 (Humble -> Rolling)",
      from: "https://docs.ros.org/en/humble/p/rclcpp/generated/classrclcpp_1_1Node.html",
      to: "rolling",
      url: "https://docs.ros.org/en/rolling/p/rclcpp/generated/classrclcpp_1_1Node.html",
    },
    {
      name: "non-core package (tf2_ros)",
      from: "https://docs.ros.org/en/humble/p/tf2_ros/generated/classtf2__ros_1_1Buffer.html",
      to: "jazzy",
      url: "https://docs.ros.org/en/jazzy/p/tf2_ros/generated/classtf2__ros_1_1Buffer.html",
    },
    {
      name: "rosdoc2 Sphinx class page -> legacy Doxygen (Jazzy -> Foxy)",
      from: "https://docs.ros.org/en/jazzy/p/rclcpp/generated/classrclcpp_1_1Node.html",
      to: "foxy",
      url: "https://docs.ros2.org/foxy/api/rclcpp/classrclcpp_1_1Node.html",
    },
    {
      name: "rosdoc2 Doxygen page -> legacy Doxygen (Jazzy -> Galactic)",
      from: "https://docs.ros.org/en/jazzy/p/rclcpp/generated/doxygen/html/classrclcpp_1_1Node.html",
      to: "galactic",
      url: "https://docs.ros2.org/galactic/api/rclcpp/classrclcpp_1_1Node.html",
    },
    {
      name: "rosdoc2 message page -> legacy (Jazzy -> Foxy)",
      from: "https://docs.ros.org/en/jazzy/p/std_msgs/msg/Header.html",
      to: "foxy",
      url: "https://docs.ros2.org/foxy/api/std_msgs/msg/Header.html",
    },
    {
      name: "package list (legacy -> rosdoc2)",
      from: "https://docs.ros2.org/foxy/api/",
      to: "jazzy",
      url: "https://docs.ros.org/en/jazzy/p/",
    },
    {
      name: "package list (rosdoc2 -> legacy)",
      from: "https://docs.ros.org/en/jazzy/p/",
      to: "galactic",
      url: "https://docs.ros2.org/galactic/api/",
    },
    {
      name: "ROS 1 message page -> rosdoc2 (Noetic -> Jazzy)",
      from: "https://docs.ros.org/en/noetic/api/std_msgs/html/msg/Header.html",
      to: "jazzy",
      url: "https://docs.ros.org/en/jazzy/p/std_msgs/msg/Header.html",
    },
    {
      name: "ROS 1 message page -> legacy (Kinetic -> Foxy)",
      from: "https://docs.ros.org/en/kinetic/api/geometry_msgs/html/msg/Twist.html",
      to: "foxy",
      url: "https://docs.ros2.org/foxy/api/geometry_msgs/msg/Twist.html",
    },
    {
      name: "unversioned ROS 1 docs (/en/api/) are Noetic",
      from: "https://docs.ros.org/en/api/nav_msgs/html/srv/GetMap.html",
      to: "humble",
      url: "https://docs.ros.org/en/humble/p/nav_msgs/srv/GetMap.html",
    },
    {
      name: "ROS 1 Doxygen class under html/c++/ -> rosdoc2 page",
      from: "https://docs.ros.org/en/noetic/api/tf2_ros/html/c++/classtf2__ros_1_1Buffer.html",
      to: "jazzy",
      url: "https://docs.ros.org/en/jazzy/p/tf2_ros/generated/classtf2__ros_1_1Buffer.html",
    },
    {
      name: "ROS 1 message package index",
      from: "https://docs.ros.org/en/noetic/api/std_msgs/html/index-msg.html",
      to: "jazzy",
      url: "https://docs.ros.org/en/jazzy/p/std_msgs/",
    },
    {
      name: "ROS 1 package list",
      from: "https://docs.ros.org/en/noetic/api/",
      to: "jazzy",
      url: "https://docs.ros.org/en/jazzy/p/",
    },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      const { match } = await resolve(c.from, c.to);
      assert.ok(match, "expected a match");
      assert.equal(match.url, c.url);
      assert.equal(match.confidence, "exact");
      assert.ok(await exists(match.url), `destination should exist: ${match.url}`);
    });
  }

  test("page missing in target -> offers package home", async () => {
    // rosdoc2's per-module Python pages have no counterpart in the legacy docs.
    const { match, fallbacks } = await resolve("https://docs.ros.org/en/jazzy/p/rclpy/rclpy.node.html", "foxy");
    assert.equal(match, null);
    assert.equal(fallbacks[0].url, "https://docs.ros2.org/foxy/api/rclpy/");
  });

  test("package missing in target -> offers package list + index.ros.org", async () => {
    const { match, fallbacks } = await resolve("https://docs.ros.org/en/jazzy/p/no_such_package_xyz/", "humble");
    assert.equal(match, null);
    assert.deepEqual(
      fallbacks.map((f) => f.url),
      ["https://docs.ros.org/en/humble/p/", "https://index.ros.org/p/no_such_package_xyz/"]
    );
  });

  test("ROS 1-only package -> offers package list + index.ros.org", async () => {
    const { match, fallbacks } = await resolve("https://docs.ros.org/en/noetic/api/roscpp/html/classros_1_1NodeHandle.html", "jazzy");
    assert.equal(match, null);
    assert.deepEqual(
      fallbacks.map((f) => f.url),
      ["https://docs.ros.org/en/jazzy/p/", "https://index.ros.org/p/roscpp/"]
    );
  });
});

describe("bulk: every page of a distro resolves to an existing page", () => {
  // Resolve a sample of pages that do NOT exist at the same path in the target,
  // and confirm each confident match really exists on the server.
  const pairs = [["foxy", "jazzy"], ["humble", "rolling"], ["rolling", "jazzy"], ["jazzy", "lyrical"]];
  for (const [from, to] of pairs) {
    test(`${from} -> ${to}`, async () => {
      const [src, tgt] = await Promise.all([ext.getIndex(from), ext.getIndex(to)]);
      const movedDocs = src.docnames.filter((d) => !tgt.pos.has(d));
      const sample = movedDocs.filter((_, i) => i % Math.ceil(movedDocs.length / 20) === 0);
      const missing = [];
      let matched = 0;
      for (const doc of sample) {
        const { match } = await resolve(`https://docs.ros.org/en/${from}/${doc}.html`, to);
        if (!match) continue;
        matched++;
        if (!(await exists(match.url))) missing.push(`${doc} -> ${match.url}`);
      }
      assert.deepEqual(missing, []);
      assert.ok(matched >= sample.length * 0.5, `only ${matched}/${sample.length} matched`);
    });
  }
});
