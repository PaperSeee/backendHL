export default async function handler(req, res) {
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).end('Unauthorized');
    }

    try {
        console.log('Cron job triggered');
        // Ajoutez ici votre logique, par exemple, appeler updateTokenData()
        await updateTokenData(); // Fonction que vous avez déjà définieee
        res.status(200).end('Cron job executed successfully');
    } catch (error) {
        console.error('Error executing cron job:', error);
        res.status(500).end('Cron job execution failed');
    }
}