# Help Preserve the Archive — Run a SermonIndex Seed Node

One of the goals of the SermonIndex Node Software is simple: make the sermon archive impossible to lose. Everyone who runs the app already helps by sharing the sermons they've downloaded. But the backbone of the network is **seed nodes** — volunteers who hold a large portion (or all) of the library and keep it available around the clock.

If you'd like to become a seed node, the first thing to sort out is storage.

**How much space do I need?**

- **Audio only** (the full mp3 library): roughly **400 GB**
- **Full library** (audio + video): roughly **2.4 TB** (about 2 TB of that is video)

You can pick "audio only" or "full" right in the app on the Seed Node page, so you don't have to commit to the whole 2.4 TB unless you want to.

**What drive should I use?**

We recommend a dedicated NVMe or USB external drive. See our [hardware setup guide](https://www.sermonindex.net/forums/hardware-guide) on the SermonIndex forums for recommendations (TerraMaster NVMe enclosures, etc.).

Keeping the library on its own drive has a few advantages: it stays separate from your everyday computer storage, it's fast enough to serve lots of people at once, and you can move it between machines if you ever upgrade your computer.

**Making it a true 24/7 node (opening your router)**

A seed node helps the most when other people can connect to it directly. The app listens on a port (TCP **42800–42839**) and first tries to open it automatically using UPnP / NAT-PMP, which works on many home routers with no effort on your part. You can check whether it worked on the **Connections** page — a reachable node shows a "Good" (or better) status.

If your router or ISP blocks the automatic setup (some do), you can forward the port by hand. It sounds technical but only takes a couple of minutes:

1. Find your computer's local IP address (for example `192.168.1.50`).
2. Log into your router — usually by typing `192.168.1.1` into a web browser.
3. Look for **Port Forwarding** (sometimes under Advanced, NAT, or "Virtual Servers").
4. Forward TCP port **42800** to your computer's local IP address.
5. Save, then restart the Node Software.

A few tips:

- Give your seed machine a **reserved (static) local IP** in your router's DHCP settings, so the forward doesn't break when addresses change.
- If your home internet IP changes from time to time, a free **Dynamic DNS** service gives you a stable hostname.
- You don't strictly *have* to open your router — even a "closed" node still uploads to others. But reachable nodes are the backbone that keeps the archive alive around the clock, so it's well worth doing if you can.

**Low-power option: a Raspberry Pi**

You don't need to leave your main computer running all day. A **Raspberry Pi 4 or 5** (4 GB RAM or more) with an external USB or NVMe drive makes an excellent always-on seed node. It draws very little power — just a few dollars of electricity a year — and can sit quietly on a shelf next to your router.

The idea: plug the drive into the Pi, run the Node Software, point the storage at the drive, and forward the port as described above. It's about as close to "set it and forget it" as a seed node gets, and it keeps your main computer free. If you're comfortable tinkering a little, it's our favorite way to run a permanent node.

**Getting started**

1. Open the SermonIndex Node Software and go to the **Seed Node** page.
2. Choose **audio only** or **full**.
3. Set the download location to your dedicated drive.
4. Let it download — for the full library this can take several days, so just leave it running.

That's it. Once the files are downloaded, your node quietly serves them to everyone else on the network. Even one more seed node makes the whole archive stronger and much harder to lose.

If you have questions about hardware or setup, reply here — we're glad to help you get going.
