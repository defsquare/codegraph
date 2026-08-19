package com.acme.order.adapter;

import com.megacorp.ledger.LedgerClient;

/** Posts to the ledger and keeps a local trail. */
public class LedgerAdapter extends LedgerClient {

    private final AuditTrail trail = new AuditTrail();

    @Override
    public void post(Object document) {
        trail.record(document);
        super.post(document);
    }
}
