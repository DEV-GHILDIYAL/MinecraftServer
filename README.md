# ⛏ Minecraft Server + Web Panel (AWS, Docker, 24/7)

Docker sirf **panel (website)** chalata hai. Minecraft servers aap website se banate ho —
name, version, difficulty, max players, game mode, whitelist, ops sab wahi se set aur change hote hain.
Har server ek alag Docker container ([itzg/minecraft-server](https://github.com/itzg/docker-minecraft-server)) hai
jo `restart: unless-stopped` ke saath chalta hai, isliye crash ya EC2 reboot ke baad bhi apne aap wapas on ho jata hai.

```
Browser ──► Panel (:8080) ──► Docker ──► mc-<name> container (:25565, :25566 …)
                                           └── world data: Docker volume mc-<name>-data
```

## 1. AWS EC2 banao

1. AWS Console → **EC2 → Launch instance**
   - **AMI:** Ubuntu Server 24.04 LTS
   - **Instance type:** `t3.medium` (4 GB, 2–5 players) ya `t3.large` (8 GB, 10+ players).
     `t2.micro` / `t3.micro` (free tier, 1 GB) Minecraft ke liye bahut chhota hai.
   - **Storage:** 20 GB+
   - **Key pair:** banao aur `.pem` file save karo
2. **Security Group → Inbound rules** add karo:

   | Type       | Port         | Source                  | Kisliye              |
   |------------|--------------|-------------------------|----------------------|
   | SSH        | 22           | My IP                   | Terminal login       |
   | Custom TCP | 8080         | My IP (ya 0.0.0.0/0)    | Web panel            |
   | Custom TCP | 25565-25575  | 0.0.0.0/0               | Minecraft players    |

3. **Elastic IP** (EC2 → Elastic IPs → Allocate → Associate with instance) — warna har restart par IP badal jayegi.

## 2. Server par install karo

```bash
ssh -i your-key.pem ubuntu@<ELASTIC-IP>
git clone https://github.com/DEV-GHILDIYAL/MinecraftServer.git
cd MinecraftServer
bash setup.sh
```

Script Docker install karta hai, `.env` banata hai (random admin password ke saath), aur panel start karta hai.
End mein panel ka URL aur password print hoga. Password badalna ho to `.env` mein `ADMIN_PASSWORD` edit karo, phir
`sudo docker compose up -d`.

> Elastic IP baad mein lagaya? `.env` mein `PUBLIC_HOST` update karo aur `sudo docker compose up -d` chalao.

## 3. Website se server banao

1. `http://<ELASTIC-IP>:8080` kholo → password se login
2. **+ New Server** → name, version, difficulty, max players, RAM, etc. → **Create Server**
3. 1–2 minute mein status **Online** (green) ho jayega
4. **Settings** se kabhi bhi koi setting badlo → server restart hota hai, world safe rehta hai
5. **Console** se live logs dekho aur commands chalao (`op Steve`, `time set day`, `whitelist add Alex`, `kick X`)

## 4. PC (Java Edition) se join karo

1. Minecraft **Java Edition** kholo (same version jo panel mein set kiya; `LATEST` = sabse naya)
2. **Multiplayer → Add Server**
3. **Server Address:** card par jo address dikh raha hai (e.g. `13.233.10.20` ya `13.233.10.20:25566`) → **Done** → Join

**Account / ID:**
- **"Premium accounts only" OFF** (default) — kisi bhi launcher (TLauncher, SKLauncher, Prism offline) se koi bhi
  username daal ke join ho sakta hai. Paid account ki zaroorat nahi.
  ⚠️ Is mode mein koi bhi kisi ka naam use kar sakta hai, isliye **Whitelist ON** karna aur ops kam rakhna safe hai.
- **ON** — sirf official paid Minecraft Java account (Microsoft login) wale join kar sakte hain.

## Useful commands (EC2 par)

```bash
sudo docker compose logs -f panel          # panel logs
sudo docker ps                             # sab containers
sudo docker logs -f mc-<name>              # kisi server ke logs
git pull && sudo docker compose up -d --build   # panel update
```

## 🤖 AI Agents (AI players jo khud survive aur civilization banate hain)

Server mein 1–5 AI players daal sakte ho (default 3: Aarav, Meera, Kabir). Ye normal survival players ki tarah
join karte hain: lakdi kaatna, tools aur armor banana, khana, ghar, farm. Aapas mein DM se baat karke khud ke rules
aur plans banate hain. Code `ai-agents/` folder mein hai
([minecraft-agent-harness](https://github.com/yc-software/minecraft-agent-harness) ke upar).

**Setup (ek baar, EC2 par):**
```bash
docker compose --profile ai build ai-agents     # AI image banao (5–10 min)
```
1. Gemini API key lo: https://aistudio.google.com → **Get API key** (free)
2. Server ka version **26.1.x** hona chahiye (26.1, 26.1.1 ya 26.1.2), aur Premium accounts **OFF**. Version `LATEST`
   ho to Settings mein exact version likho, wahi jo Console mein `Starting minecraft server version ...` dikhata hai.
   `LATEST` apne aap naye version par upgrade kar deta hai, aur version kabhi neeche mat karna.
3. Server ke **🤖 AI** tab mein API key daalo → **Save** → **▶ Start AI**

**Dhyan rakho:**
- Start se pehle world ka backup apne aap liya jata hai (Backups tab mein "🤖 AI start se pehle").
- AI ko OP nahi milta aur wo commands nahi chala sakte, bas normal player ki tarah khelte hain.
  "Spawn se door ghar banao, doosron ka saaman mat todo" jaise rules sirf AI ko diye gaye instructions hain.
  AI kabhi galti kare to Backups se restore karo.
- **Free tier:** Gemini free key ki daily limit kam hoti hai. Limit khatam hote hi agents ruk jaate hain aur agle din
  (1:30 PM IST ke baad) apne aap phir chalu ho jaate hain. RAM: 3 agents ≈ 1.5 GB extra.
- AI tab mein live activity aur agents ki aapas ki baatcheet (💬) dikhti hai.

## 💾 Backups & World regenerate

- **Auto backup:** har `BACKUP_INTERVAL_HOURS` (default 6) ghante mein chalte hue server ka world backup hota hai.
  `0` = band. Disk 2 GB se kam ho to auto backup skip hota hai.
- **Settings change se pehle** apne aap backup hota hai (sirf jab sach mein kuch badla ho).
- **Regenerate / Restore se pehle** bhi purane world ka backup liya jata hai, to kuch bhi galat hua to wapas aa sakte ho.
- Har server ke last `BACKUP_KEEP` (default 8) auto backups + 8 baaki backups rakhe jaate hain, purane delete.
- **Backups tab:** Backup now, ↩ Restore (chaaho to us waqt ki settings bhi), ⬇ Download, 🗑 Delete.
- **Settings → 🌍 Regenerate world:** world glitch / void mein gir rahe ho? Naya Overworld + Nether + End banta hai
  (seed khaali = random). Plugins, ops, whitelist, settings same rehte hain.

Backups Docker volume `mc-backups` mein hain (EC2 disk par hi). Off-site copy ke liye ⬇ Download karke apne PC par rakho.
Server delete karne par bhi uske backups rehte hain.

## Security notes
- Panel ke paas Docker ka control hai (= server ka root access). **Strong password** rakho aur
  Security Group mein port 8080 sirf apne IP ke liye kholo agar ho sake.
- Panel HTTP par chalta hai. HTTPS chahiye to aage Caddy/Nginx reverse proxy laga sakte ho.
