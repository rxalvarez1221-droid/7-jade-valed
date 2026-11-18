# 7-Jade ValEd

Christmas (green + hearts) picture site. Express + MongoDB. Images are stored inside MongoDB,
so nothing is lost when Render restarts.

## Add your logo
Log in as admin (below) and press **Change logo**. It is saved in MongoDB.
Rules and Regulations pictures: in admin mode, each activity card (Prize Wheel, Kindness Chair, Freedom Wall) has an **Add rules picture** button; visitors press the card to see it.
(Or save it as `public/logo.png` as a fallback.)

## Admin
Click the bottom part of the logo (invisible). Password is `1221`
(change it with the `ADMIN_PASSWORD` env var). Once in, you can edit the message and
add / replace / delete pictures in each tab.

## Run on your MacBook (M4)
```bash
brew install node          # skip if you already have Node 18+
cd 7-jade-valed
npm install
cp .env.example .env       # then paste your MONGODB_URI into .env
npm start                  # open http://localhost:3000
```

## MongoDB Atlas (free)
1. Create a free M0 cluster at mongodb.com/atlas.
2. Database Access: add a user + password.
3. Network Access: add `0.0.0.0/0` (Render's IPs change).
4. Connect > Drivers: copy the connection string into `MONGODB_URI`.

## Deploy on Render
1. Push this folder to its own GitHub repo.
2. Render: New > Web Service > pick the repo.
3. Build command `npm install`, start command `npm start`.
4. Environment: add `MONGODB_URI` (and optionally `ADMIN_PASSWORD`).
