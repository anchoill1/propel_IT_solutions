<?php
header('Content-Type: application/json');

// Only accept POST requests
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success' => false, 'message' => 'Invalid request']);
    exit;
}

// Collect and sanitise form fields
$first_name = htmlspecialchars(strip_tags(trim($_POST['first_name'] ?? '')));
$last_name  = htmlspecialchars(strip_tags(trim($_POST['last_name'] ?? '')));
$email      = filter_var(trim($_POST['email'] ?? ''), FILTER_SANITIZE_EMAIL);
$business   = htmlspecialchars(strip_tags(trim($_POST['business'] ?? '')));
$service    = htmlspecialchars(strip_tags(trim($_POST['service'] ?? '')));
$message    = htmlspecialchars(strip_tags(trim($_POST['message'] ?? '')));

// Basic validation
if (empty($first_name) || empty($last_name) || empty($email)) {
    echo json_encode(['success' => false, 'message' => 'Missing required fields']);
    exit;
}

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    echo json_encode(['success' => false, 'message' => 'Invalid email address']);
    exit;
}

// Email settings
$to      = 'joe@adopt-it.ie';
$subject = "New Enquiry from {$first_name} {$last_name} — Adopt IT Solutions";

$body = "You have a new enquiry from your website.\n\n";
$body .= "-------------------------------------------\n";
$body .= "Name:     {$first_name} {$last_name}\n";
$body .= "Email:    {$email}\n";
$body .= "Business: {$business}\n";
$body .= "Service:  {$service}\n";
$body .= "-------------------------------------------\n\n";
$body .= "Message:\n{$message}\n\n";
$body .= "-------------------------------------------\n";
$body .= "Sent from adopt-it.ie\n";

$headers  = "From: noreply@adopt-it.ie\r\n";
$headers .= "Reply-To: {$email}\r\n";
$headers .= "X-Mailer: PHP/" . phpversion();

// Send email
$sent = mail($to, $subject, $body, $headers);

if ($sent) {
    // Send auto-reply to the enquirer
    $reply_subject = "Thanks for getting in touch — Adopt IT Solutions";
    $reply_body  = "Hi {$first_name},\n\n";
    $reply_body .= "Thanks for reaching out to Adopt IT Solutions.\n\n";
    $reply_body .= "I've received your message and will get back to you within one business day.\n\n";
    $reply_body .= "In the meantime, feel free to visit our website at adopt-it.ie.\n\n";
    $reply_body .= "Best regards,\n";
    $reply_body .= "Joe Murray\n";
    $reply_body .= "Founder, Adopt IT Solutions\n";
    $reply_body .= "joe@adopt-it.ie\n";
    $reply_body .= "adopt-it.ie\n";

    $reply_headers  = "From: joe@adopt-it.ie\r\n";
    $reply_headers .= "X-Mailer: PHP/" . phpversion();

    mail($email, $reply_subject, $reply_body, $reply_headers);

    echo json_encode(['success' => true]);
} else {
    echo json_encode(['success' => false, 'message' => 'Mail delivery failed']);
}
?>
