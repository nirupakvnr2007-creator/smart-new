import React, { useState } from 'react';
import { CustomerReview, ProductItem, SalesTransaction, ShopProfile } from '../../types';
import { QRCodeSVG } from '../../utils/qrGenerator';
import { apiVerifyPurchase, apiSaveReview } from '../../services/api';

interface PublicCustomerFeedbackScreenProps {
  productId: string;
  products: ProductItem[];
  shop: ShopProfile | null;
  transactions: SalesTransaction[];
  reviews: CustomerReview[];
  onAddReview: (review: CustomerReview) => void;
  onClose: () => void;
  onShowToast: (msg: string) => void;
}

export const PublicCustomerFeedbackScreen: React.FC<PublicCustomerFeedbackScreenProps> = ({
  productId,
  products,
  shop,
  transactions,
  reviews,
  onAddReview,
  onClose,
  onShowToast
}) => {
  const product = products.find((p) => p.id === productId);

  // Verification state
  const [phoneInput, setPhoneInput] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationResult, setVerificationResult] = useState<{
    verified: boolean;
    receiptNumber?: string;
    timestamp?: string;
    errorMsg?: string;
  } | null>(null);
  const [verifiedPhone, setVerifiedPhone] = useState<string | null>(null);

  // Review form state
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>(['Freshness', 'Quality']);
  const [isSubmitted, setIsSubmitted] = useState(false);

  if (!product) {
    return (
      <div className="min-h-screen bg-[#f8f9ff] flex flex-col items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center space-y-3 border border-[#dae2fd]">
          <span className="material-symbols-outlined text-[48px] text-[#ba1a1a]">
            error_outline
          </span>
          <h2 className="font-headline font-bold text-[18px] text-[#0b1c30]">
            Product Not Found
          </h2>
          <p className="text-[13px] text-[#565e74]">
            The product QR feedback code does not match any registered product in the store database.
          </p>
          <button
            onClick={onClose}
            className="mt-3 px-4 py-2 bg-[#0037b0] text-white rounded-lg text-[13px] font-bold cursor-pointer"
          >
            Return to Store
          </button>
        </div>
      </div>
    );
  }

  const productReviews = reviews.filter((r) => r.productId === product.id);
  const avgRating =
    productReviews.length > 0
      ? (productReviews.reduce((sum, r) => sum + r.rating, 0) / productReviews.length).toFixed(1)
      : '5.0';

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  // Verify buyer phone number against transactions in DB
  const handleVerifyPurchase = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanInput = phoneInput.replace(/\D/g, '');
    if (cleanInput.length < 6) {
      setVerificationResult({
        verified: false,
        errorMsg: 'Please enter a valid mobile number (at least 6 digits).'
      });
      return;
    }

    setIsVerifying(true);
    setVerificationResult(null);

    try {
      // 1. Try server verification endpoint first
      const serverResult = await apiVerifyPurchase(product.id, phoneInput.trim());
      if (serverResult.verified) {
        setVerificationResult({
          verified: true,
          receiptNumber: serverResult.receiptNumber || 'Verified In-Store',
          timestamp: serverResult.timestamp || 'Recent Purchase'
        });
        setVerifiedPhone(phoneInput.trim());
        onShowToast('Purchase verified! You can now submit your rating and feedback.');
        setIsVerifying(false);
        return;
      }
    } catch {
      // Local transactions verification check
    }

    // 2. Local database transactions check
    const matchedTxn = transactions.find((txn) => {
      const cleanTxnPhone = (txn.customerPhone || '').replace(/\D/g, '');
      const phoneMatches =
        cleanTxnPhone.length >= 6 &&
        (cleanTxnPhone.includes(cleanInput) || cleanInput.includes(cleanTxnPhone));
      const hasProduct = txn.items?.some(
        (item) => item.productId === product.id || item.sku === product.sku
      );
      return phoneMatches && hasProduct;
    });

    setIsVerifying(false);

    if (matchedTxn) {
      setVerificationResult({
        verified: true,
        receiptNumber: matchedTxn.receiptNumber,
        timestamp: matchedTxn.timestamp
      });
      setVerifiedPhone(phoneInput.trim());
      onShowToast('Purchase verified! Feedback form unlocked.');
    } else {
      setVerificationResult({
        verified: false,
        errorMsg: `Verification failed: Mobile number "${phoneInput}" has no recorded purchase for "${product.name}". To ensure genuine feedback, only customers who purchased this item can leave a review.`
      });
    }
  };

  const handleReviewSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!verifiedPhone) {
      onShowToast('Mobile verification required before posting review.');
      return;
    }

    if (!comment.trim()) {
      onShowToast('Please enter your review feedback.');
      return;
    }

    const newReview: CustomerReview = {
      id: `rev-${Date.now()}`,
      productId: product.id,
      productName: product.name,
      customerPhone: verifiedPhone,
      rating,
      comment: comment.trim(),
      tags: selectedTags,
      timestamp: new Date().toLocaleDateString([], {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      }),
      isVerified: true
    };

    onAddReview(newReview);
    await apiSaveReview(newReview);
    setIsSubmitted(true);
    onShowToast('Thank you! Your verified feedback has been submitted to the store database.');
  };

  const qrUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/?feedback=${product.id}`
      : product.qrCode;

  return (
    <div className="min-h-screen bg-[#f8f9ff] text-[#0b1c30] flex flex-col font-sans antialiased pb-12 selection:bg-[#dce1ff] selection:text-[#001551]">
      {/* Top Header */}
      <header className="bg-white border-b border-[#e5eeff] sticky top-0 z-40 px-4 py-3 shadow-xs">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#0037b0] text-white flex items-center justify-center">
              <span className="material-symbols-outlined text-[20px]">verified</span>
            </div>
            <div>
              <span className="font-headline font-bold text-[14px] text-[#0b1c30] block">
                {shop?.name || 'Smart Retail Store'}
              </span>
              <span className="text-[10px] text-[#565e74]">
                Verified Product Packaging Feedback Portal
              </span>
            </div>
          </div>

          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg bg-[#eff4ff] hover:bg-[#dae2fd] text-[#0037b0] text-[12px] font-bold flex items-center gap-1 cursor-pointer transition-colors"
          >
            <span className="material-symbols-outlined text-[16px]">store</span>
            <span>Back to Store</span>
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-2xl mx-auto w-full p-4 space-y-4 flex-grow">
        {/* Product Identity Card */}
        <div className="bg-white rounded-2xl p-5 shadow-xs border border-[#e5eeff] flex flex-col sm:flex-row items-center gap-4">
          <div className="p-2 bg-[#f8f9ff] border border-[#dae2fd] rounded-xl shrink-0">
            <QRCodeSVG value={qrUrl} size={110} />
          </div>

          <div className="flex-1 text-center sm:text-left space-y-1">
            <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
              <span className="font-mono text-[10px] font-bold bg-[#dce1ff] text-[#0039b5] px-2 py-0.5 rounded">
                {product.sku}
              </span>
              <span className="text-[10px] font-bold bg-[#85f8c4] text-[#002114] px-2 py-0.5 rounded">
                Verified Packaging QR
              </span>
            </div>
            <h1 className="font-headline font-bold text-[20px] text-[#0b1c30]">{product.name}</h1>
            <p className="text-[12px] text-[#565e74]">
              Brand: <strong>{product.brand}</strong> • Category: {product.category}
            </p>
            <div className="flex items-center justify-center sm:justify-start gap-3 pt-1">
              <span className="font-headline font-bold text-[18px] text-[#0037b0]">
                ₹{product.price}
              </span>
              <div className="flex items-center gap-1 text-[12px] font-bold text-[#0b1c30]">
                <span className="material-symbols-outlined text-[#ffab00] text-[16px]" style={{ fontVariationSettings: "'FILL' 1" }}>
                  star
                </span>
                <span>{avgRating} ({productReviews.length} verified reviews)</span>
              </div>
            </div>
          </div>
        </div>

        {/* STEP 1: MOBILE VERIFICATION GATE */}
        {!verifiedPhone ? (
          <div className="bg-white rounded-2xl p-5 shadow-xs border border-[#dae2fd] space-y-4">
            <div className="flex items-center gap-2 pb-2 border-b border-[#eff4ff]">
              <span className="material-symbols-outlined text-[#0037b0] text-[22px]">
                phonelink_lock
              </span>
              <div>
                <h2 className="font-headline font-bold text-[16px] text-[#0b1c30]">
                  Step 1: Mobile Buyer Verification
                </h2>
                <p className="text-[11px] text-[#565e74]">
                  Enter the phone number you gave the cashier at checkout to verify your purchase.
                </p>
              </div>
            </div>

            <form onSubmit={handleVerifyPurchase} className="space-y-3">
              <div className="space-y-1">
                <label className="text-[12px] font-semibold text-[#0b1c30]">
                  Purchased Customer Mobile Number *
                </label>
                <div className="flex items-center gap-2">
                  <div className="flex-1 flex items-center gap-2 bg-[#eff4ff] border border-[#dae2fd] rounded-xl px-3 py-2.5 focus-within:bg-white focus-within:border-[#0037b0] focus-within:ring-2 focus-within:ring-[#0037b0]/20">
                    <span className="material-symbols-outlined text-[#565e74] text-[18px]">
                      call
                    </span>
                    <input
                      type="tel"
                      required
                      placeholder="e.g. 9840123456"
                      value={phoneInput}
                      onChange={(e) => setPhoneInput(e.target.value)}
                      className="w-full bg-transparent text-[14px] text-[#0b1c30] outline-none"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isVerifying}
                    className="px-5 py-2.5 bg-[#0037b0] hover:bg-[#1d4ed8] disabled:opacity-50 text-white rounded-xl text-[13px] font-bold cursor-pointer transition-all shadow-xs shrink-0 flex items-center gap-1.5"
                  >
                    {isVerifying ? (
                      <span>Verifying...</span>
                    ) : (
                      <>
                        <span className="material-symbols-outlined text-[16px]">verified</span>
                        <span>Verify Buyer</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {verificationResult && !verificationResult.verified && (
                <div className="p-3 bg-[#ffdad6] border border-[#ffb4ab] rounded-xl text-[12px] text-[#93000a] flex items-start gap-2">
                  <span className="material-symbols-outlined text-[18px] shrink-0 mt-0.5">
                    gpp_bad
                  </span>
                  <div>
                    <span className="font-bold block">Access Restricted</span>
                    <span>{verificationResult.errorMsg}</span>
                  </div>
                </div>
              )}

              <div className="p-3 bg-[#f8f9ff] rounded-xl border border-[#dae2fd] text-[11px] text-[#565e74] space-y-1">
                <div className="flex items-center gap-1.5 font-bold text-[#0b1c30]">
                  <span className="material-symbols-outlined text-[#0037b0] text-[15px]">info</span>
                  <span>Why is verification required?</span>
                </div>
                <p>
                  To protect shop integrity and prevent anonymous spam, only genuine buyers who completed counter billing for this item can submit ratings.
                </p>
              </div>
            </form>
          </div>
        ) : (
          /* STEP 2: VERIFIED BUYER FEEDBACK FORM */
          <div className="bg-white rounded-2xl p-5 shadow-xs border border-[#dae2fd] space-y-4">
            {/* Verification Success Badge */}
            <div className="p-3 bg-[#85f8c4]/20 border border-[#85f8c4] rounded-xl flex items-center justify-between gap-3 text-[#002114]">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[#004f35] text-[20px]">
                  verified
                </span>
                <div>
                  <span className="text-[13px] font-bold block">
                    Verified Buyer: {verifiedPhone}
                  </span>
                  <span className="text-[11px] text-[#565e74]">
                    Invoice #{verificationResult?.receiptNumber || 'Purchased'} • Authenticated Customer
                  </span>
                </div>
              </div>
              <button
                onClick={() => {
                  setVerifiedPhone(null);
                  setVerificationResult(null);
                }}
                className="text-[11px] text-[#ba1a1a] font-bold hover:underline cursor-pointer"
              >
                Change Phone
              </button>
            </div>

            {isSubmitted ? (
              <div className="text-center py-8 space-y-2">
                <div className="w-12 h-12 rounded-full bg-[#85f8c4] text-[#002114] flex items-center justify-center mx-auto">
                  <span className="material-symbols-outlined text-[28px]">check</span>
                </div>
                <h3 className="font-headline font-bold text-[17px] text-[#0b1c30]">
                  Feedback Submitted Successfully!
                </h3>
                <p className="text-[12px] text-[#565e74] max-w-sm mx-auto">
                  Thank you for rating {product.name}. Your verified review helps other customers and shop managers maintain top product quality.
                </p>
                <button
                  onClick={() => setIsSubmitted(false)}
                  className="mt-3 px-4 py-2 bg-[#eff4ff] text-[#0037b0] rounded-lg text-[12px] font-bold cursor-pointer"
                >
                  Write Another Note
                </button>
              </div>
            ) : (
              <form onSubmit={handleReviewSubmit} className="space-y-4">
                <div className="space-y-1">
                  <label className="text-[12px] font-semibold text-[#0b1c30]">
                    Your Rating (1 to 5 Stars) *
                  </label>
                  <div className="flex items-center gap-1 pt-1">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <button
                        key={star}
                        type="button"
                        onClick={() => setRating(star)}
                        className="cursor-pointer text-[#ffab00] hover:scale-110 transition-transform p-1"
                      >
                        <span
                          className="material-symbols-outlined text-[32px]"
                          style={{ fontVariationSettings: star <= rating ? "'FILL' 1" : "'FILL' 0" }}
                        >
                          star
                        </span>
                      </button>
                    ))}
                    <span className="text-[14px] font-bold text-[#0b1c30] ml-3">
                      {rating} / 5 Stars
                    </span>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[12px] font-semibold text-[#0b1c30]">
                    Quality Attributes
                  </label>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {[
                      'Freshness',
                      'Packaging Quality',
                      'Value for Money',
                      'Taste / Flavour',
                      'Overall Satisfaction'
                    ].map((tag) => {
                      const isSelected = selectedTags.includes(tag);
                      return (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => toggleTag(tag)}
                          className={`px-3 py-1.5 rounded-full text-[11px] font-semibold transition-colors cursor-pointer border ${
                            isSelected
                              ? 'bg-[#0037b0] text-white border-[#0037b0]'
                              : 'bg-[#eff4ff] text-[#565e74] border-[#dae2fd]'
                          }`}
                        >
                          {tag}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[12px] font-semibold text-[#0b1c30]">
                    Your Verified Review *
                  </label>
                  <textarea
                    rows={4}
                    required
                    placeholder="Describe product freshness, packaging condition, and value..."
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    className="w-full bg-[#eff4ff] border border-[#dae2fd] p-3 rounded-xl text-[13px] text-[#0b1c30] outline-none focus:bg-white focus:border-[#0037b0] resize-none"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full py-3 bg-[#0037b0] hover:bg-[#1d4ed8] text-white rounded-xl text-[14px] font-bold shadow-md cursor-pointer flex items-center justify-center gap-2 active:scale-[0.99] transition-all"
                >
                  <span className="material-symbols-outlined text-[18px]">send</span>
                  <span>Post Verified Review to Store Database</span>
                </button>
              </form>
            )}
          </div>
        )}

        {/* Existing Community Reviews */}
        <div className="bg-white rounded-2xl p-5 shadow-xs border border-[#e5eeff] space-y-3">
          <div className="flex items-center justify-between pb-2 border-b border-[#eff4ff]">
            <h3 className="font-headline font-bold text-[15px] text-[#0b1c30]">
              Verified Community Reviews ({productReviews.length})
            </h3>
            <span className="text-[11px] text-[#004f35] font-bold flex items-center gap-1">
              <span className="material-symbols-outlined text-[14px]">verified</span>
              <span>100% Verified Purchases</span>
            </span>
          </div>

          {productReviews.length === 0 ? (
            <div className="text-center py-8 text-[#565e74] text-[12px]">
              No customer reviews yet. Be the first verified buyer to leave feedback!
            </div>
          ) : (
            <div className="divide-y divide-[#eff4ff] space-y-3 pt-1">
              {productReviews.map((rev) => (
                <div key={rev.id} className="pt-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-[13px] text-[#0b1c30]">
                        {rev.customerPhone
                          ? `Buyer (***${rev.customerPhone.slice(-4)})`
                          : 'Verified Customer'}
                      </span>
                      <span className="px-1.5 py-0.2 rounded bg-[#85f8c4] text-[#002114] text-[9px] font-bold">
                        VERIFIED ✓
                      </span>
                    </div>
                    <span className="text-[11px] text-[#565e74]">{rev.timestamp}</span>
                  </div>

                  <div className="flex items-center gap-1 text-[#ffab00]">
                    {[1, 2, 3, 4, 5].map((s) => (
                      <span
                        key={s}
                        className="material-symbols-outlined text-[16px]"
                        style={{ fontVariationSettings: s <= rev.rating ? "'FILL' 1" : "'FILL' 0" }}
                      >
                        star
                      </span>
                    ))}
                  </div>

                  {rev.tags && rev.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {rev.tags.map((t) => (
                        <span
                          key={t}
                          className="px-2 py-0.5 bg-[#eff4ff] text-[#0037b0] text-[10px] rounded-full font-medium"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}

                  <p className="text-[12px] text-[#434655] leading-relaxed">{rev.comment}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
};
