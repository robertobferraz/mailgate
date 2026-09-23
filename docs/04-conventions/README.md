# 04-conventions — code rules

- 0001 worker writes to a run are guarded by lease token
- 0002 never create-and-catch P2002 inside a transaction
- 0003 time logic uses the database clock
- 0004 no network calls inside database transactions
- 0005 Claude history is append-only
