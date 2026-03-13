## Railway deployment notes

Railway deployment requires Athena vocabulary files to be uploaded manually to the `terminology-service` persistent volume after first deploy.

### Required steps

1. Deploy the stack to Railway.
2. Open the `terminology-service` volume in the Railway dashboard.
3. Upload:
   - `CONCEPT.csv`
   - `CONCEPT_RELATIONSHIP.csv`
   - `CONCEPT_SYNONYM.csv`
4. Restart the `terminology-service`.

`TERMINOLOGY_AUTOLOAD_ON_START` must be set to `true` in Railway environment variables.
